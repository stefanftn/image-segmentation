/**
 * config.js — every tunable value in the client, in one place.
 *
 * Nothing here is a security boundary. The size/type limits mirror the
 * backend's `Upload:MaxFileSizeBytes` / `Upload:AllowedContentTypes` so the
 * user finds out about a bad file instantly instead of after a 10 MB upload,
 * but the backend re-validates every one of them (backend spec §11) and its
 * answer is the authoritative one. When backend config changes, change these
 * numbers — no logic file should ever need editing to point this app at a
 * different environment.
 */
/**
 * Same file ships in both the local-dev image and the production image (no build-time
 * templating in this project) - so which backend to talk to is decided at RUNTIME, from the
 * page's own hostname, not hardcoded. Local dev (docker-compose.yml, this container on
 * :5173) always talks to a genuinely different origin (:8080) and needs an explicit absolute
 * URL. Production (moleraj.stefanpopovic.site) serves the frontend and backend on the SAME
 * origin via nginx path-routing ("/" -> frontend, "/api/" and "/hubs/" -> backend - see
 * deploy/nginx-additions.conf), so an empty API_BASE_URL - meaning "relative to this page's
 * own origin" - is both correct and simpler than hardcoding the production domain here.
 */
const isLocalDev = ["localhost", "127.0.0.1"].includes(window.location.hostname);

export const CONFIG = {
  /** The only backend host this app knows about — one ASP.NET Core process
   *  now, not a gateway routing to separate services.
   *  Empty string in production means "same origin as this page" (see the
   *  isLocalDev note above) - apiUrl()/apiHubUrl() below just concatenate
   *  this with a leading-slash path, which resolves correctly either way. */
  API_BASE_URL: isLocalDev ? "http://localhost:8080" : "",

  /** Path the SignalR client connects to for task status updates. Joined onto
   *  API_BASE_URL the same way every REST path is, via apiUrl() - confirmed
   *  against the backend's actual hub mapping (`app.MapHub<TaskStatusHub>("/hubs/tasks")`
   *  in Program.cs). */
  SIGNALR_HUB_PATH: "/hubs/tasks",

  /* ---- real-time tracking (spec §2) ---- */
  /** Past this, swap the message for "still going" — but keep tracking.
   *  Wall-clock since the hub was joined, not since the last push. */
  TRACKING_SOFT_TIMEOUT_MS: 60_000,
  /** Past this, stop waiting and hand the user a choice. Deliberately a
   *  different mechanism from the backend's StaleTaskSweeperWorker (§9.2);
   *  this one exists only so the UI never waits forever. Keep it at or above
   *  Processing:MaxTaskDurationMinutes plus a buffer. */
  TRACKING_HARD_TIMEOUT_MS: 20 * 60_000,
  /** Extra budget granted when the user chooses "keep waiting". */
  TRACKING_EXTENSION_MS: 5 * 60_000,

  /* ---- client-side validation (spec §5) ---- */
  MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024,
  ALLOWED_CONTENT_TYPES: ["image/png", "image/jpeg", "image/webp"],
  /** Names a saved region selection. Nothing on the backend bounds this, so
   *  the cap is purely so the chips and the saved-group list stay legible. */
  MAX_GROUP_NAME_LENGTH: 60,

  /* ---- what the backend can be asked for ---- */
  /** The two operations `POST /api/images/process` accepts. `Segment` runs a
   *  fixed wall model; `Regions` returns a SAM label map with no semantics at
   *  all, which the client turns into a mask by letting the user pick regions.
   *  The server matches these case-insensitively; they are sent as written. */
  OPERATIONS: ["Segment", "Regions"],
  /** Only meaningful for `Segment` — the server ignores `mode` on a Regions
   *  submission. Kept here rather than in markup so the selector, validation
   *  and the submitted value can never disagree. */
  SEGMENT_MODES: ["interior", "exterior"],

  /* ---- saved selections (mask groups) ---- */
  /** Group writes share the backend's 20/minute submission budget, which is
   *  sized for uploading images, not for a user renaming selections. Saving is
   *  an explicit button rather than an autosave, and this is the shortest gap
   *  between two accepted writes — a guard against a double-click becoming two
   *  groups, since this endpoint takes no Idempotency-Key. */
  GROUP_WRITE_MIN_INTERVAL_MS: 800,

  /* ---- masking (spec §6) ---- */
  /** 0–255 grayscale cutoff for "this pixel is inside the entity". Only used
   *  when the mask arrives without a meaningful alpha channel. */
  MASK_THRESHOLD: 128,
  /** Soft edge, in grayscale levels either side of the threshold. 0 gives a
   *  hard binary cut; a few levels hide the staircase on diagonal edges. */
  MASK_FEATHER: 12,

  /* ---- performance ---- */
  /** Longest edge of the live preview. Dragging a slider re-composites at
   *  this size; export re-composites once at full resolution. */
  PREVIEW_MAX_EDGE: 1200,

  /* ---- network retries ---- */
  /** Network-level retries of a single submit, reusing the same
   *  Idempotency-Key so a retry can never create a second task. */
  SUBMIT_NETWORK_RETRIES: 2,
  /** The task already succeeded server-side, so a failing /result fetch is
   *  worth retrying harder than a poll is. */
  MASK_FETCH_RETRIES: 4,
  MASK_FETCH_BACKOFF_MS: 700,

  /* ---- editing presets ---- */
  /** Paint-chip presets. Names are what a person would say out loud. */
  COLOR_PRESETS: [
    { name: "Chalk",      hex: "#efeae1" },
    { name: "Bone",       hex: "#d8cfbe" },
    { name: "Clay",       hex: "#b4694a" },
    { name: "Brick",      hex: "#8c3f34" },
    { name: "Olive",      hex: "#6b7145" },
    { name: "Sage",       hex: "#8fa08a" },
    { name: "Teal",       hex: "#2f6f6b" },
    { name: "Slate",      hex: "#4a5560" },
    { name: "Ink",        hex: "#232a33" },
    { name: "Denim",      hex: "#3f5c86" },
    { name: "Plum",       hex: "#5c3a55" },
    { name: "Mustard",    hex: "#c69422" },
    { name: "Rust",       hex: "#a8542a" },
    { name: "Moss",       hex: "#3f5a3a" },
    { name: "Sand",       hex: "#c9b48c" },
    { name: "Graphite",   hex: "#3a3b3d" },
  ],
};

/** Convenience: absolute URL for a backend path. */
export function apiUrl(path) {
  return `${CONFIG.API_BASE_URL.replace(/\/+$/, "")}${path}`;
}
