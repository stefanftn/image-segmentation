# ImageSeg — Backend

A single deployable ASP.NET Core backend for wall segmentation. Given an uploaded photo, it
either finds a wall mask automatically (`Operation=Segment`, choosing between an interior or
exterior model) or returns an interactive SAM region map the client can click together into a
named selection (`Operation=Regions`). The backend never renders or edits an image — every
visual change (colour, texture) happens client-side, composited against the mask or region
selection this backend produces.

## Architecture

Four projects, Onion Architecture:

```
ImageSeg.Domain           zero dependencies: entities, enums, exceptions, every interface
ImageSeg.Application       depends ONLY on Domain: services, the processing pipeline, options
ImageSeg.Infrastructure    implements Domain interfaces: EF Core, MinIO, the AI sidecar clients
ImageSeg.Web                depends on Application + Infrastructure: controllers, SignalR hub,
                             Identity wiring, middleware, and Program.cs — the composition root
```

A controller depends only on an `Application` interface (`IImageTaskService`,
`IMaskGroupService`). A service depends only on a `Domain` interface
(`IImageTaskRepository`, `IStorageService`, `ISegmentationClient`). Neither ever references a
concrete `Infrastructure` class. `Program.cs` is the one exception: it is the composition root,
and composition roots are allowed to know everything so they can wire it together.

### Processing pipeline

Uploaded images are processed by a `TaskPoller` background service, not a message queue: it
claims pending tasks directly from Postgres with `SELECT ... FOR UPDATE SKIP LOCKED`, which
guarantees two poller instances (e.g. two scaled-out replicas) never claim the same row
concurrently. Once a claimed task's state moves past `Pending`, it becomes structurally
invisible to the claim query — the `WHERE State = 'Pending'` predicate itself excludes it — so
a crash mid-processing leaves the task stuck rather than silently reprocessed. Recovery for
that case is `StaleTaskSweeperWorker`'s job: it periodically force-fails any task that's been
non-terminal for too long.

Each claimed task runs through a small decorator chain — logging, retry, image preprocessing,
then the actual AI sidecar call — before its result (a mask or a region label map) is uploaded
to MinIO and its row marked `Completed`.

### Real-time updates

`TaskStatusHub` (SignalR) pushes a status update to any client that's joined a task's group,
right after every state-changing database write. `GET /api/images/{id}/status` still exists as
a plain REST read, used for the initial state on first connect or after a dropped WebSocket
reconnects.

### Storage

MinIO holds every original upload and every result (mask or region map). The backend never
proxies file bytes through itself for reads — `GET /result` and `GET /original` both 302-redirect
to a short-lived presigned MinIO URL, so the browser fetches the actual bytes directly.

## Authentication

ASP.NET Core Identity (`UserManager`/`SignInManager`/`RoleManager`) handles
password/lockout/2FA/external-login bookkeeping; `JwtTokenService`
(`ImageSeg.Web/Identity`) signs and validates the JWT bearer tokens the API actually hands out
to clients — the frontend this backend serves is a separately-hosted static app, so a
cross-origin cookie was never a workable credential to begin with.

- `POST /api/auth/register`, `POST /api/auth/login` — return `{ token, expiresAtUtc }`, or
  `{ requiresTwoFactor: true, twoFactorToken }` when the account has 2FA enabled.
- `POST /api/auth/2fa/verify` — completes a login that returned a 2FA challenge: takes the
  short-lived `twoFactorToken` from that response plus a 6-digit TOTP code, returns a real
  access token.
- `POST /api/auth/2fa/setup` / `POST /api/auth/2fa/enable` / `POST /api/auth/2fa/disable` —
  manage 2FA for the caller's own account (`[Authorize]`).
- `GET /api/auth/google/login?returnUrl=` — starts the Google OAuth flow. Only registered as a
  scheme at all when `Authentication:Google:ClientId`/`:ClientSecret` are both set; otherwise
  this route returns a clean 404 and password auth works exactly as normal.

Every protected route (`ImagesController`, `MaskGroupsController`, the 2FA-management
endpoints) uses `[Authorize]` and reads the caller's id from the JWT's `NameIdentifier` claim.

## Storage backend and AI sidecar

`IStorageService` and `ISegmentationClient` are both interfaces with exactly one production
implementation each (MinIO; a local FastAPI sidecar) — kept as interfaces specifically so a
second backend or a second AI provider is a new class, not a rewrite. `ISegmentationClient`'s
one implementation, `RoutingSegmentationClient`, always sends `Segment` requests to the local
sidecar and routes `Regions` requests to either the local sidecar or an optional GPU-backed
Google Colab notebook, based on `AiSidecar:RegionsBackend` config. An unreachable Colab backend
fails the task outright with a clear error rather than silently falling back to the CPU path.

## API surface

| Route | Auth | Notes |
|---|---|---|
| `POST /api/images/process` | required | multipart: `image` + `operation` (`Segment`\|`Regions`) + `mode` (required only for `Segment`). Returns `202` + `{ requestId, correlationId, state }` |
| `GET /api/images/{id}/status` | none | `{ requestId, operation, mode, state, updatedAtUtc, isTerminal, errorMessage, resultUrl }` |
| `GET /api/images/{id}/result` | none | `302` to a presigned MinIO URL, or `409` if the task isn't `Completed` |
| `GET /api/images/{id}/original` | none | The uploaded photo, at any task state |
| `DELETE /api/images/{id}` | required, owner-scoped | Deletes the task row, its saved region groups, and its storage objects |
| `GET /api/images` | required, owner-scoped | Caller's own tasks, `?operation=`/`?state=` filters, capped at 100, newest first |
| `POST /api/images/{id}/groups` | required, owner-scoped | Saves a named region selection. Only valid for a `Completed` `Regions` task |
| `PUT /api/images/{id}/groups/{groupId}` | required, owner-scoped | Updates a saved selection |
| `DELETE /api/images/{id}/groups/{groupId}` | required, owner-scoped | |
| `GET /api/images/{id}/groups` | required, owner-scoped | Every saved selection for a task |

`/status`, `/result`, and `/original` are intentionally unscoped — anyone holding a task id can
read its status and fetch its files, since the id itself functions as the access token for that
resource. Owner-scoped routes return `404`, not `403`, when the caller doesn't own the
resource, so a non-owner can't distinguish "doesn't exist" from "exists, not yours."

## Running it

Generate the initial migration once (not committed — every environment generates its own from
the current model):

```bash
cd src/ImageSeg.Web
dotnet ef migrations add InitialCreate --project ../ImageSeg.Infrastructure --startup-project .
```

Set up your environment file and bring the stack up:

```bash
cp deploy/.env.example deploy/.env   # then edit deploy/.env with real values
docker compose -f deploy/docker-compose.yml run --rm migrate   # apply migrations once
docker compose -f deploy/docker-compose.yml up --build
```

Every credential and per-environment value (Postgres, MinIO, CORS origins, the JWT signing
key, Google OAuth, the Colab backend URL) lives in `deploy/.env`, not in `docker-compose.yml`
itself — see `deploy/.env.example` for what each one does. `deploy/.env` is gitignored;
`deploy/.env.example` is the committed template. It has to live in `deploy/`, not the repo
root: Compose resolves its default `.env` file relative to the directory of the first `-f`
file passed to it, not your current working directory.

Migrations are applied as an explicit step (`docker compose run --rm migrate`), not
automatically on `web`'s startup — that keeps multiple scaled-out `web` replicas from racing
each other to migrate the same database on every deploy. `dotnet ImageSeg.Web.dll --migrate`
is the same binary as the running app, just invoked with a flag, so there's no separate image
to build or keep in sync.

The only application entrypoint is `web`, published at `http://localhost:8080`. MinIO's own
ports (`9000`/`9001`) are published too, deliberately — presigned URLs are fetched by the
browser directly from MinIO, so it can't be internal-only.

Scale the web tier:

```bash
docker compose -f deploy/docker-compose.yml up --scale web=3
```

Every replica runs its own `TaskPoller` and `StaleTaskSweeperWorker`; both are safe under
concurrent replicas by construction (see "Processing pipeline" above).

### Google OAuth

Set real values in `deploy/.env` before enabling Google sign-in:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

Register `http://localhost:8080/api/auth/signin-google` as the authorized redirect URI in
Google Cloud Console for local dev — this is the OAuth handler's `CallbackPath`, set in
`Program.cs`'s `AddGoogle` call (the ASP.NET Core default would be `/signin-google`; it's moved
under `/api/` so it matches the reverse proxy's existing `/api/` routing in production, instead
of needing its own dedicated nginx location block). This is what Google actually receives as
`redirect_uri`. It is **not** `/api/auth/external-login-callback`: that path only comes into
play *after* the OAuth handler's own callback handling finishes and redirects the browser
onward internally — Google itself never sees or redirects to it.

### Generating a new migration

```bash
cd src/ImageSeg.Web
dotnet ef migrations add <Name> --project ../ImageSeg.Infrastructure --startup-project .
```

`AppDbContextFactory` (`ImageSeg.Infrastructure/Persistence`) lets this run without the full
app host, reading `ConnectionStrings:Postgres` from `appsettings.json`/environment the same way
the running app does.

## Testing

```bash
cd tests/ImageSeg.Tests
dotnet test
```

`tests/ImageSeg.Tests` covers the auth surface (`ImageSeg.Web.Identity.AuthController`) end to
end against a real, fully-wired instance of the app (`WebApplicationFactory<Program>` — same
middleware pipeline, same DI composition), with Postgres/MinIO/the AI sidecar swapped for an
isolated in-memory SQLite database and the background workers (`TaskPoller`,
`StaleTaskSweeperWorker`) removed, since auth tests never touch either. See
`TestWebApplicationFactory.cs` for exactly what's swapped and why.

What's covered, happy path and failure cases together:

- **Registration** — valid credentials issue a working token; duplicate email, and each
  individual password rule (length, uppercase, lowercase, digit, non-alphanumeric), are
  rejected with 400.
- **Login** — valid credentials issue a token; wrong password and no-such-account both return
  the *same* status and message, so a caller can't enumerate registered emails one guess at a
  time; five failed attempts lock the account out even for a sixth, correct password.
- **Two-factor** — setup → enable (with a real, freshly-computed TOTP code — see `Totp.cs`)
  returns 10 recovery codes; a login for a 2FA-enabled account returns a challenge token, not
  an access token; completing that challenge with the right code returns a real one. Failure
  cases include a wrong code, a garbage/expired challenge token, and a normal access token fed
  into the challenge-verification endpoint (rejected, since it carries the wrong `purpose`
  claim — proving that check actually does something, not just that the JWT signature is
  valid).
- **Google login when unconfigured** returns a clean 404, never an unhandled server error.
- **A token from `/register` or `/login` actually authorizes a protected endpoint**
  (`GET /api/images`) — confirms the token is usable end to end, not just shaped correctly.
