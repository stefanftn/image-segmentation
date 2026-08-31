# ImageSeg

A tool for repainting one surface in a photo — a wall, most often — without touching anything
else in the picture. Upload a photo, find or pick the surface, then adjust its colour and
texture live in the browser.

Monorepo with three independently-built pieces:

- **`back/`** — ASP.NET Core backend (REST API, SignalR, authentication) plus the Python AI
  sidecar that does the actual wall segmentation. See [`back/README.md`](back/README.md).
- **`front/`** — the browser client. Plain HTML/CSS/JS, no build step. See
  [`front/README.md`](front/README.md).
- **`deploy/`** — production deployment: a self-hosted CI/CD pipeline and the compose file that
  runs on the production VM. See [`deploy/README.md`](deploy/README.md). This is a *different*
  compose setup from `back/deploy/`, which is local-dev-only and still builds images from
  source — don't confuse the two.
- **`.github/workflows/`** — three independent pipelines (`backend.yml`, `ai-sidecar.yml`,
  `frontend.yml`). Each one only triggers on changes under its own path, builds one image
  directly on the production VM, and restarts only that one service — a frontend change never
  rebuilds or restarts the backend, and vice versa.

## Local development

Backend + AI sidecar + Postgres + MinIO:

```bash
cd back
docker compose -f deploy/docker-compose.yml run --rm migrate
docker compose -f deploy/docker-compose.yml up --build
```

Frontend, separately:

```bash
cd front
docker compose up --build
```

The frontend serves on `http://localhost:5173`, the backend on `http://localhost:8080` — see
each subfolder's own README for everything beyond that (configuration, testing, production
deployment).
