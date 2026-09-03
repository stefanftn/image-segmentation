# Maskwork

A browser tool for repainting one surface in a photo — a wall, most often —
without touching anything else in the picture. Upload a photo, find or pick
the surface, then adjust its colour and texture live. The server does the
one expensive, genuinely hard part — figuring out which pixels belong to the
surface — and returns that as a mask. Everything after that, every slider
drag, every brush stroke, happens in the browser against the photo you
already have. No editing action ever makes a network call.

Plain HTML, CSS, and JavaScript. No framework, no build step, no bundler —
what's in this repository is exactly what runs, unmodified.

---

## What it does

**Signing in.** Every session belongs to a real account — email/password,
"Continue with Google", and a TOTP second factor where the account has one
enabled. There is no anonymous or dev-mode path; local development signs in
against a real local account the same way any other environment does.

**Finding the surface — two ways.**
- *Find the wall* runs a fixed model that looks for wall surfaces on its
  own. You pick interior or exterior; nothing to click.
- *Pick regions myself* splits the photo into small clickable regions with
  no semantic meaning of their own — the model has no idea which ones are
  "wall". You click the ones that add up to a surface (often three or four:
  a lit part, a shaded part, the strip under a window) and give the
  selection a name. Selections can be saved and reopened later, and several
  can exist side by side on one photo.

**Editing — all local, all live.** Once a surface exists as a mask, editing
never touches the network again. The edit panel is organised into five
tabs — Surfaces, Colour, Adjust, Mask, Export:

- *Colour* — a swatch grid or a custom picker, an intensity dial (0% is the
  untouched photo, 100% is the flat literal colour — not a translucent
  wash), and a Blend Mode (Normal, Multiply, Soft Light, Overlay) for
  letting the wall's own shading and texture show back through the new
  colour instead of flattening it. Specular Highlights isolates the
  brightest points of the *original* photo — glare, a light fixture's
  reflection — and screens them back on top of the finished colour or
  texture, so a repainted wall still catches light the way the real one did.
- *Adjust* — hue and saturation shifts; a set of procedural textures
  (brick, plaster, wood, tile, and more), each with its own strength,
  rotation, size (how large the tile pattern reads — finer or coarser), and
  a "depth" slider that compresses one edge of the tile toward the other,
  a cheap one-axis suggestion of a wall receding at an angle. For an actual
  multi-point perspective fit, **Perspective Warp** puts a draggable
  control-point grid directly on the photo (2×2 by default — a plain
  4-corner quad — growable to as many rows and columns as the wall's shape
  needs) and warps the texture through a true projective transform, cell by
  cell, so a tile can be bent around a corner or fitted to a wall that
  photographed as more than one flat plane.
- *Mask* — Brush and Eraser with a size slider and an optional magnifier
  (shows the actual brush footprint at true size, live, over what's being
  painted, not a stale frame); Grow/Shrink to move the whole boundary in or
  out by a pixel amount; Feather to soften the edge instead of leaving a
  hard cut. Every stroke and every slider settle is its own undo step.
- *Export* — a full-resolution PNG; a side-by-side Before/After image with
  labels burned into the pixels; the mask itself as a standalone PNG with
  alpha, for touching up in another tool.

Every numeric slider has a matching type-in field next to it — drag for
speed, type for an exact value. A mask-edge overlay (Adjust tab) traces the
selection's exact boundary in a two-tone outline when you need to check
precisely where it falls, and a Before/After split-slider compares the
edited result against the untouched photo at any point. Multiple surfaces
can exist on one photo, independently edited and reorderable — order
matters, since a later surface paints over an earlier one wherever they
overlap. Every edit action (not just the visible ones — undo/redo too) is
one step in a real history, undoable and redoable, per surface.

**Appearance.** A Settings dialog (gear icon in the masthead, or the
hamburger menu on a phone) holds a light/dark theme toggle and a language
picker — English only today, but the string tables and the picker are
already there for more.

**Mobile.** The masthead collapses to a single thin bar — logo, name, and a
hamburger menu holding New Photo, Settings, and Sign Out. The edit panel
becomes a bottom sheet that can be dragged to any height by hand, not just
toggled open or closed, and collapses out of the way automatically the
moment a brush stroke starts so it never blocks the photo underneath it.

**Nothing is one-shot.** A saved selection can be reopened later — the tool
remembers recent jobs and can fully restore any of them, photo included, in
one click, even a job that failed (so you can see what was tried). Clicking
a job in that list first shows a quick look at its photo before committing
to reopen it. A job that's no longer wanted can be deleted outright from
the same list (through a themed confirmation dialog, not the browser's own
unstyleable `confirm()`). Reloading the page mid-edit resumes the same
session automatically rather than dropping back to the empty upload
screen, and the edits themselves — brush strokes, colour, texture, warp,
everything in this list — are cached locally as you work and restored the
moment a surface is reopened, so a browser crash or an accidental refresh
doesn't mean starting over. See **Local persistence**, below, for exactly
what that does and doesn't cover today.

**Export.** A full-resolution PNG, a Before/After comparison image, or the
mask alone — all generated and downloaded entirely in the browser, no
server round trip for any of them.

---

## How it's built

### The split that makes editing free

The backend's job ends the moment it hands back a mask (or, for manual
picking, a raw region map with no meaning attached to any given region).
Everything downstream — colour, texture, warp, comparing before and after,
exporting — is Canvas 2D compositing running against pixels already in
memory. That's the whole reason editing has no per-action network cost: the
expensive work (segmentation) happens once, server-side; the cheap, fast,
interactive work (turning a mask into a finished look) happens client-side,
as many times as you like.

Perspective Warp is the one piece of that worth calling out specifically:
Canvas 2D has no native projective-transform primitive, only affine
(scale/rotate/skew/translate). A true perspective fit is built by
subdividing the warped region into a fine mesh of small triangles — a
triangle always maps correctly under an affine transform — and drawing each
one through its own locally-computed transform. Enough small triangles
make the curve of the real projection invisible at any single one. The
control-point grid (2×2 up to 5×5 per side) works the same way one level
up: each cell between four neighbouring control points gets its own
homography, so dragging one interior point bends only the cells that touch
it, not the whole texture.

Resuming an old session leans on the same "server keeps the source of
truth, browser does the work" idea from the other direction: the backend
can hand back the *original* uploaded photo for any job, in any state,
including one that failed — not just a finished result. That's what makes
"reopen this" a single click instead of "reopen this, then also go find the
same file on your disk."

### Local persistence

Two different things are cached locally, for two different reasons:

- **Which job is open** (`localStorage`, one small key) — so a page reload
  mid-edit resumes automatically instead of landing on the empty upload
  screen. Cleared by "New photo", by signing out, or by deleting that job.
- **The edits themselves** (`IndexedDB`, via `js/editcache.js`) — the
  edited mask and every slider/toggle in the list above, keyed by the
  layer's own id (`{requestId}:{n}` for a Segment result, `group:{id}` for
  a saved Regions selection). Saved automatically, debounced, on every
  undo/redo checkpoint, and flushed immediately if the tab is hidden or
  closed. Restored automatically the moment that same layer id is created
  again — reopening a job, or switching back to a surface built from a
  saved selection.

Both are **same-device only** today — nothing here syncs across devices,
and both can be lost if the browser's site data is cleared. The real fix is
a backend endpoint for the edits (the "which job" pointer is cheap enough
that it may never need one). `docs/edits-persistence-contract.md` specifies
that endpoint in detail — request/response shapes, why it's a new resource
rather than an extension of the existing mask-groups one — and
`docs/backend-edits-persistence-prompt.md` is the same information written
as a ready-to-hand-to-an-LLM implementation prompt. `js/editcache.js`'s own
`{ edits, mask }` shape was written to match that contract on purpose, so
wiring the real thing in later is additive: try the server first, fall back
to the local copy only if that fails.

### Talking to the backend

Every request goes to one place — a single ASP.NET Core process, the only
backend host this client knows about. Broadly: sign in (email/password,
Google, and a TOTP second factor where enabled); submit a photo and get a
task id back; track that task's status over a SignalR connection (a
one-shot REST read covers the moment right after joining and right after
any reconnect — see the comments in `js/app.js`'s tracking section); once
it's done, fetch the mask (or region map) and the original photo;
optionally save, update, delete, or list named region selections; list
recent jobs to resume one later, or delete one outright. Client-side checks
(file size, type, a selection's name) exist purely for fast feedback — the
backend re-validates everything independently, and its answer is the one
that actually counts.

### File structure

```
index.html            markup for every screen — there's only one page
styles.css             all visual design
Dockerfile               builds a static nginx image, no build step needed
docker-compose.yml         for running it standalone
nginx.conf                   no-cache headers for index.html/styles.css/js/,
                              so a rebuild is visible without a hard refresh

assets/
  logo-moleraj.png          the logo, used as a CSS mask so it re-colours
                             itself for whichever theme is active

docs/
  edits-persistence-contract.md        the proposed backend API for
                                        permanent (cross-device) edit storage
  backend-edits-persistence-prompt.md   the same, as a ready-to-paste
                                        implementation prompt

js/
  config.js              the handful of values you'd change per environment
  api.js                 every network call, in one file — REST and auth alike
  state.js                a small state machine: idle → uploading → tracking → ready/error
  compositor.js             canvas compositing — masks, layering, colour/
                             texture/warp math; the only file that touches a
                             canvas's pixels directly
  regions.js                 the click-to-select region picker
  controls.js                  the property panel: sliders, swatches, the
                                surfaces list, undo/redo history
  editcache.js                   local (IndexedDB) persistence for edits —
                                  see "Local persistence" above
  i18n.js                         t(key, vars) + static-string application;
                                   strings/en.js holds the actual English text
  app.js                            wires everything above together, incl.
                                     auth screens and the SignalR connection
                                     for live task status — the only file
                                     that knows what should happen when

  tools/                    interactive canvas tools — each owns its own
                             pointer/drag handling and talks to compositor.js
                             through the same setEdits() funnel every other
                             control uses
    brush.js                  Brush & Eraser, incl. the live magnifier
    warp.js                     Perspective Warp's draggable control-point
                                 grid (add/remove row/column, drag-to-shape)

  ui/                       standalone UI chrome — each of these owns one
                             self-contained widget, knows nothing about the
                             editor's own state machine, and could be
                             deleted without breaking anything else here
    theme.js                   light/dark theme state + the Settings
                                dialog's Light/Dark radio pair
    settings.js                   opens/closes the Settings dialog from its
                                   three entry points
    sidebar.js                      the mobile hamburger drawer
    edittabs.js                       the Surfaces/Colour/Adjust/Mask/Export
                                       tabs, and — on a phone — the same
                                       grouping as a freely-draggable bottom
                                       sheet
    infotip.js                          click/tap/hover ⓘ tooltips, kept
                                         inside whatever would otherwise
                                         clip them
    confirm.js                            a themed replacement for
                                           window.confirm(), for the two
                                           destructive actions in the app

  strings/
    en.js                    every user-facing string, English
```

Each file has one job. `api.js` is the only file that knows an HTTP request
exists; `compositor.js` is the only file that touches a canvas's pixels
directly; `app.js` is the only file that knows what should happen when.
Everything in `ui/` and most of `tools/` is intentionally standalone —
addressed by DOM id, reachable at parse time, no shared module state with
`app.js` beyond the handful of explicit exports each one has (`getTheme`/
`setTheme`, `collapseSheet`, `confirmDialog`, and so on). Deeper reasoning
behind specific decisions — why a colour blend uses one mode over another,
why a particular retry has the shape it does — lives as comments next to
the code it explains, not here.

---

## Running it

### Docker

```bash
docker compose up --build
```

Serves on **http://localhost:5173**, matching what the backend's CORS
configuration already expects. The `--build` matters: this image is a
snapshot taken at build time (`COPY . /usr/share/nginx/html` in the
Dockerfile), so a plain `docker compose up` after editing a file reuses the
old image and won't show the change — rebuild, don't just restart.

To start it alongside the backend with a single command instead, add this
folder as a service in the backend's own `docker-compose.yml`:

```yaml
frontend:
  build: ./front
  ports:
    - "5173:80"
```

### Any static file server

The frontend is just static files, so anything that serves them over HTTP
works — the only hard requirement is HTTP, not a `file://` path, since
browsers refuse to load JavaScript modules from disk.

```bash
python -m http.server 5173
# or: npx serve -l 5173
```

### Pointing it at a backend

`js/config.js` picks `API_BASE_URL` at runtime, based on the page's own hostname — not a
fixed value to edit per environment:

```js
const isLocalDev = ["localhost", "127.0.0.1"].includes(window.location.hostname);

API_BASE_URL: isLocalDev ? "http://localhost:8080" : "",   // "" = same origin as this page
SIGNALR_HUB_PATH: "/hubs/tasks",
```

On `localhost`/`127.0.0.1` it talks to `http://localhost:8080`, matching local Docker Compose.
Anywhere else, an empty string means "relative to this page's own origin" — the common case in
production, where the frontend and backend are served from the same domain via path-based
routing (`/` → frontend, `/api/` and `/hubs/` → backend). If the backend genuinely lives on a
different origin in some deployment, change the non-`isLocalDev` branch to that origin instead.

Signing in, including on localhost, goes through the same email/password, Google, and 2FA
screens as any other environment, against a real account on whatever backend `API_BASE_URL`
points at — there's no dev-mode bypass.
