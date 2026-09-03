# Deploy — self-hosted runner, isolated under `moleraj`'s rootless Docker

Four independent pipelines (`.github/workflows/{backend,ai-sidecar,frontend,monitoring}.yml`), each
reacting only to changes in its own part of the code and restarting only its own service(s).
Backend/ai-sidecar/frontend each build their image directly on the VM (no registry involved);
monitoring has no build step - `prom/prometheus` and `grafana/grafana` are plain upstream images.

**The entire pipeline runs as the `moleraj` Linux user, inside its own isolated rootless
Docker** — fully separate from the root Docker daemon that runs `reverse-proxy` (and, through
it, `docs`/`ketering`). This is not optional: if the runner ever ran as root, every merge to
this repo would gain effective control over the whole machine, not just this app.

## 1. Register a self-hosted runner (as the `moleraj` user)

```bash
sudo -iu moleraj
mkdir -p ~/actions-runner && cd ~/actions-runner

# Exact link/version: GitHub repo -> Settings -> Actions -> Runners -> New self-hosted runner
# (that page gives you a download link and a token specific to this repo)
curl -o actions-runner-linux-x64.tar.gz -L <link-from-the-GitHub-page>
tar xzf actions-runner-linux-x64.tar.gz

./config.sh --url https://github.com/<owner>/<repo> --token <token-from-the-GitHub-page> \
  --labels moleraj --name moleraj-runner
```

When asked for a working directory, leave the default (`_work`) — this is the ephemeral
checkout that gets cleaned before every job (`git clean -ffdx`), which is why secrets (`.env`)
live outside it (step 3).

Install it as a `systemd --user` service (not a system service, not root):

```bash
./svc.sh install
./svc.sh start
```

Confirm the runner is online: GitHub repo → Settings → Actions → Runners.

## 2. Confirm `moleraj` actually has rootless Docker without sudo

```bash
sudo -iu moleraj
docker info   # should work without sudo, and should NOT show root's containers (reverse-proxy etc.)
docker ps     # should be empty, or show only moleraj's own containers
```

If `docker ps` shows `reverse-proxy` or anything belonging to `docs`/`ketering`, `moleraj` does
not actually have an isolated Docker daemon, and that needs fixing before continuing.

## 3. Secrets — outside the git checkout, on a stable path

```bash
sudo -iu moleraj
mkdir -p ~/imageseg-secrets
cp <this-repo>/deploy/.env.example ~/imageseg-secrets/.env
nano ~/imageseg-secrets/.env   # fill in every value - see the comments in the file
chmod 600 ~/imageseg-secrets/.env
```

A working copy of the code, for the first manual deploy — every deploy after this one is
handled by the workflow itself via the runner:

```bash
git clone https://github.com/<owner>/<repo>.git ~/imageseg
```

## 4. Add nginx routing (on the root side, outside the `moleraj` user)

See `deploy/nginx-additions.conf` for exactly what changes (the existing `moleraj` `location /`
block splits into four: `/monitoring/`, `/api/`, `/hubs/`, `/`) and what's new (a whole new
`minio.stefanpopovic.site` block). Grafana does **not** get its own subdomain — it's nested
under the existing `moleraj.stefanpopovic.site` origin, at its own top-level path `/monitoring/`
(a sibling of `/api/`, not inside it — nesting it under `/api/` would blur the line between the
real REST API and a monitoring UI). Reuses the existing subdomain/certificate, no new DNS record.
Run as whichever user has access to `/opt/reverse-proxy/`:

```bash
nano /opt/reverse-proxy/conf.d/default.conf
docker exec reverse-proxy nginx -t
docker exec reverse-proxy nginx -s reload
```

## 5. DNS

Add to Cloudflare (or your DNS provider), same pattern as `moleraj`/`docs`/`ketering`:

```
minio.stefanpopovic.site   A   VPS_PUBLIC_IP
```

The wildcard certificate (`*.stefanpopovic.site`) already covers this — no new certificate
needed, just the DNS record. Monitoring needs **no DNS change at all** — it lives at
`moleraj.stefanpopovic.site/monitoring/`, an existing hostname.

## 6. First deploy, by hand

```bash
sudo -iu moleraj
cd ~/imageseg
docker build -t imageseg-web:latest -f back/src/ImageSeg.Web/Dockerfile back
docker build -t imageseg-ai-sidecar:latest -f back/src/AiSidecar/Dockerfile back/src/AiSidecar
docker build -t imageseg-frontend:latest -f front/Dockerfile front

docker compose --env-file ~/imageseg-secrets/.env -f deploy/docker-compose.prod.yml run --rm migrate
docker compose --env-file ~/imageseg-secrets/.env -f deploy/docker-compose.prod.yml up -d
```

Every deploy after this one is automatic — merge to `main`, the matching workflow builds and
restarts only that one service.

## Port layout

| Port | Service |
|---|---|
| 4000 | docs |
| 4001 | ImageSeg backend (`web`) |
| 4002 / 4003 | Ketering app / API |
| 4004 | ImageSeg frontend |
| 4005 | MinIO S3 API, public via `minio.stefanpopovic.site` |
| 4006 | Grafana, public via `moleraj.stefanpopovic.site/monitoring/` (see below) |

## Monitoring (Prometheus/Grafana)

Optional layer on top of the spec §11 four-service target — nothing else `depends_on` these two,
so the app runs fine without them. Deployed by its own workflow (`.github/workflows/monitoring.yml`),
same pattern as backend/ai-sidecar/frontend, triggered by changes under `deploy/monitoring/**`
(scrape config, Grafana provisioning). It does **not** trigger on changes elsewhere in
`deploy/docker-compose.prod.yml` (e.g. bumping the `prom/prometheus`/`grafana/grafana` image tag)
since that file is shared by every service — for that one case, run
`workflow_dispatch` by hand (GitHub repo → Actions → Monitoring — deploy → Run workflow) or SSH in
and run the two `docker compose` commands from the workflow yourself.

- **Prometheus** scrapes `web:8080/metrics` (prometheus-net.AspNetCore — HTTP request metrics
  plus `imageseg_taskpoller_claimed_total`, `imageseg_inflight_tasks`,
  `imageseg_sweeper_force_failed_total`) and `ai-sidecar:8000/metrics` (already instrumented —
  `sidecar_segment_latency_seconds`, `sidecar_model_ready{model}`, etc.). It is **not** published
  on any host port — only Grafana talks to it, over the internal `imageseg` Docker network.
- **Grafana** is reachable at `https://moleraj.stefanpopovic.site/monitoring/` once step 4's
  nginx block is applied. First login is `GRAFANA_ADMIN_USER`/`GRAFANA_ADMIN_PASSWORD` from
  `~/imageseg-secrets/.env` — the latter has no built-in default in
  `deploy/docker-compose.prod.yml`, so it must actually be set there before the first `up`.
  Prometheus is pre-wired as its datasource (`deploy/monitoring/grafana-provisioning/`); drop a
  dashboard JSON into `deploy/monitoring/grafana-provisioning/dashboards/` (see that folder's
  README for two ready-made community dashboards) and Grafana picks it up within 30s, no restart.

## Why frontend and backend share an origin, and MinIO doesn't

`moleraj.stefanpopovic.site/` (frontend) and `moleraj.stefanpopovic.site/api/` (backend) are
the **same origin** from the browser's perspective (same domain, different path) — the CORS
check mostly never even runs for calls between them. `minio.stefanpopovic.site` is a
**different origin** (a subdomain counts as a different origin), so it still needs to be in
`CORS_ALLOWED_ORIGINS` (plus the `,null` suffix `docker-compose.prod.yml` adds automatically —
see `back/README.md` for the "tainted origin" explanation of why a redirect target needs that).

`front/js/config.js` already adapts to this at runtime: `API_BASE_URL` is chosen from the
page's own hostname — `http://localhost:8080` when opened on `localhost`/`127.0.0.1` (local
dev), an empty string (same origin as the page) everywhere else. Since frontend and backend
share an origin in production, an empty string is both correct and simpler than hardcoding a
domain — no separate build needed for production.

## What's still missing

- **Backups.** `postgres-data`/`minio-data` are Docker volumes on a single VM, with no
  replication or snapshot schedule.
- **Alerting for a failed deploy.** Right now a failed workflow just shows red in the Actions
  tab — nobody gets notified.
