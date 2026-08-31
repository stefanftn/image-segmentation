# Maskwork

A browser tool for repainting one surface in a photo — a wall, most often —
without touching anything else in the picture. Upload a photo, find or pick
the surface, then adjust its colour and texture live. The server does the
one expensive, genuinely hard part — figuring out which pixels belong to the
surface — and returns that as a mask. Everything after that, every slider
drag, happens in the browser against the photo you already have. No editing
action ever makes a network call.

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
never touches the network again:
- Colour, with hue, saturation, and an intensity dial rather than a flat
  on/off — the tint blends toward the original rather than replacing it
  outright.
- A set of procedural textures (brick, plaster, wood, tile, and more), each
  with its own strength, rotation, and a "depth" control that compresses one
  edge of the tile toward the other — useful for a surface photographed at
  an angle, where one side reads as nearer than the other.
- A before/after slider to compare the edited result against the untouched
  photo, and a mask-edge overlay to check exactly where the surface's
  boundary actually falls.
- Multiple surfaces on one photo, independently editable and reorderable —
  order matters, since a later surface paints over an earlier one wherever
  they overlap.
- Zoom, on both the region picker and the editor, mouse-wheel or buttons.

**Nothing is one-shot.** A saved selection can be reopened later — the tool
remembers recent jobs and can fully restore any of them, photo included, in
one click, even a job that failed (so you can see what was tried). Clicking
a job in that list first shows a quick look at its photo before committing
to reopen it. A job that's no longer wanted can be deleted outright from
the same list. Editing itself never waits on saving; saving only exists so a
selection can be found again tomorrow.

**Export.** A full-resolution PNG, generated and downloaded entirely in the
browser — no server round trip for that either.

---

## How it's built

### The split that makes editing free

The backend's job ends the moment it hands back a mask (or, for manual
picking, a raw region map with no meaning attached to any given region).
Everything downstream — colour, texture, comparing before and after,
exporting — is Canvas 2D compositing running against pixels already in
memory. That's the whole reason editing has no per-action network cost: the
expensive work (segmentation) happens once, server-side; the cheap, fast,
interactive work (turning a mask into a finished look) happens client-side,
as many times as you like.

Resuming an old session leans on the same idea from the other direction:
the backend can hand back the *original* uploaded photo for any job, in any
state, including one that failed — not just a finished result. That's what
makes "reopen this" a single click instead of "reopen this, then also go
find the same file on your disk."

### Talking to the backend

Every request goes to one place — a single ASP.NET Core process, the only
backend host this client knows about. Broadly: sign in (email/password, Google, and a
TOTP second factor where enabled); submit a photo and get a task id back;
track that task's status over a SignalR connection (a one-shot REST read
covers the moment right after joining and right after any reconnect — see
the comments in `js/app.js`'s tracking section); once it's done, fetch the
mask (or region map) and the original photo; optionally save, update,
delete, or list named region selections; list recent jobs to resume one
later, or delete one outright. Client-side checks (file size, type, a
selection's name) exist purely for fast feedback — the backend re-validates
everything independently, and its answer is the one that actually counts.

### File structure

```
index.html         markup for every screen — there's only one page
styles.css          all visual design
Dockerfile           builds a static nginx image, no build step needed
docker-compose.yml    for running it standalone
js/
  config.js          the handful of values you'd change per environment
  api.js             every network call, in one file — REST and auth alike
  state.js            a small state machine: idle → uploading → tracking → ready/error
  compositor.js        canvas compositing — masks, layering, colour/texture math
  regions.js             the click-to-select region picker
  controls.js             the property panel: sliders, swatches, the surfaces list
  app.js                 wires everything above together, incl. auth screens and
                          the SignalR connection for live task status
```

Each file has one job. `api.js` is the only file that knows an HTTP request
exists; `compositor.js` is the only file that touches a canvas's pixels
directly; `app.js` is the only file that knows what should happen when.
Deeper reasoning behind specific decisions — why a colour blend uses one
mode over another, why a particular retry has the shape it does — lives as
comments next to the code it explains, not here.

---

## Running it

### Docker

```bash
docker compose up
```

Serves on **http://localhost:5173**, matching what the backend's CORS
configuration already expects. `docker compose up --build` after any file
change.

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
