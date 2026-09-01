/**
 * app.js — entry point. Wires state.js, api.js, compositor.js, regions.js and
 * controls.js together, and owns the one thing none of them own: the flow.
 *
 * There are two ways a surface gets chosen now, and they converge fast:
 *
 *   Segment  → the backend returns a wall mask → it becomes a layer.
 *   Regions  → the backend returns a label map → the user clicks regions
 *              together → that selection resolves to a mask → it becomes a
 *              layer.
 *
 * Past the point where a layer exists, the two are indistinguishable, which is
 * why the compositor needed no changes for any of this. All the new machinery
 * lives on the near side of `addLayer`.
 *
 * Session lifetime is still memory-only for the photo itself: the original
 * lives in an in-memory object URL and nowhere else, because the backend does
 * not store or return the uploaded bytes independently of the job. Saved
 * selections do survive — they are region ids on the server — so "resume"
 * means restoring saved selections over a photo the user re-opens locally.
 */

import { CONFIG } from "./config.js";
import { t } from "./i18n.js";
import {
  submitTask, pollStatus, fetchResult, fetchOriginal, newIdempotencyKey,
  listImages, listMaskGroups, createMaskGroup, updateMaskGroup, deleteMaskGroup,
  deleteImage, setAuthToken, getAuthToken, ApiError, TASK_STATES,
  login, register, verifyTwoFactor, googleLoginUrl,
} from "./api.js";
import { createMachine, STATE } from "./state.js";
import { Compositor, loadImageFromBlob, createLabelMap, isUnedited } from "./compositor.js";
import { createRegionPicker } from "./regions.js";
import { createControls } from "./controls.js";
import { createBrushTool } from "./brush.js";

/**
 * Fails loudly, in one place, rather than as a cryptic "Cannot read
 * properties of undefined" three modules downstream. The usual cause isn't a
 * bug here — it's a browser serving a cached or stale copy of config.js from
 * before OPERATIONS/SEGMENT_MODES existed. A hard refresh (Ctrl+Shift+R) or
 * re-extracting the project folder from scratch fixes it in that case.
 */
(function assertConfigShape() {
  const required = ["OPERATIONS", "SEGMENT_MODES", "API_BASE_URL"];
  const missing = required.filter((key) => CONFIG[key] === undefined);
  if (missing.length) {
    const message =
      `config.js is missing ${missing.join(", ")}. This is usually a stale or `
      + `cached copy of the file, not a real config problem — try a hard refresh `
      + `(Ctrl+Shift+R) or re-extract the project folder from scratch.`;
    document.body.innerHTML =
      `<pre style="padding:24px;font:13px monospace;white-space:pre-wrap;">${message}</pre>`;
    throw new Error(message);
  }
})();

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ *
 * Session
 * ------------------------------------------------------------------ */

const session = {
  /* the photo — local only, never re-fetchable from the backend */
  file: null,
  fileUrl: null,
  originalImage: null,

  /* what the form is currently asking for */
  operation: CONFIG.OPERATIONS[0],
  mode: CONFIG.SEGMENT_MODES[0],

  /* the task being watched or read */
  requestId: null,
  correlationId: null,
  idempotencyKey: null,
  taskOperation: null,   // as reported by /status — decides how to read /result
  taskMode: null,

  /* Regions only */
  labelMap: null,
  groups: [],
  editingGroupId: null,
  /** id of the layer standing in for the selection currently being built,
   *  before it's tied to any saved group (req 4 — see useSelection/saveGroup
   *  for how this gets reconciled to a real group id once one exists). */
  draftLayerId: null,
  groupWriteInFlight: false,
  lastGroupWriteAt: 0,
  layerSeq: 0,

  /* "Open" clicked on this task — kept so a failed /original fetch can be
   *  retried against the exact same task without reconstructing it. */
  lastOpenAttempt: null,

  /* flow bookkeeping */
  reusingImage: false,
  clockTimer: null,
  countdownTimer: null,
  trackingStartedAt: 0,
  hardDeadline: 0,
};

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ *
 * Independent of `session` above — a signed-out visitor has no task, so
 * there is nothing task-shaped to reset when signing in or out. Kept at
 * module scope for the same reason session is: one source of truth, read
 * from wherever it's needed.
 */
const auth = {
  /** Set while a 2FA screen is showing; the value login()/register() handed
   *  back, needed by verifyTwoFactor(). Cleared on success or cancel. */
  twoFactorToken: null,
  /** What to do once a sign-in that was triggered by a 401 completes —
   *  set by handleFailure's "auth" case, consumed once by completeAuth().
   *  Null means "just land on the idle screen", the ordinary post-login
   *  destination. */
  resumeAction: null,
};

const machine = createMachine();
const compositor = new Compositor($("display"), { beforeCanvas: $("beforeCanvas") });
const controls = createControls({
  compositor,
  onEdit: () => updateReadout(),
  onHistoryChange: ({ canUndo, canRedo }) => {
    $("undoBtn").disabled = !canUndo;
    $("redoBtn").disabled = !canRedo;
  },
});
const picker = createRegionPicker({
  canvas: $("picker"),
  onChange: onSelectionChange,
});

const brush = createBrushTool({
  compositor,
  getActiveLayerId: () => controls.activeId,
  canvasBox: document.querySelector(".canvasbox"),
  displayCanvas: $("display"),
  drawCanvas: $("maskDrawSurface"),
  cursorEl: $("brushCursor"),
  magnifierEl: $("brushMagnifier"),
  magnifierCanvas: $("brushMagnifierCanvas"),
  onStrokeCommitted: () => {
    controls.commitHistoryCheckpoint();
    updateReadout();
  },
});

/** Assigned in wire() — see wireZoom(). Needs to exist at module scope so
 *  resetAll() can reset both zoom levels on a genuinely new photo. */
let zoomCtl = null;

/** The one SignalR connection for the tab, opened lazily on first use and
 *  reused across every task tracked afterward — see connectHub(). A fresh
 *  connection per task would work too, but reusing one avoids repeatedly
 *  paying the negotiate/handshake cost for something that outlives any
 *  single task. */
let hubConnection = null;
let hubConnectPromise = null;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

let toastTimer = 0;
function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setFieldError(node, message) {
  node.textContent = message || "";
  node.hidden = !message;
}

function slug(text) {
  return String(text || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Human name for a job, used in the tracking panel and layer labels. */
function describeJob(operation, mode) {
  if (operation === "Regions") return "Regions";
  return mode ? `Wall (${mode})` : "Wall";
}

function isRegionsTask() {
  return session.taskOperation === "Regions" && Boolean(session.labelMap);
}

/**
 * "A photo is loaded" is tracked as a body class (existing behaviour, used by
 * CSS to keep the stage from blanking between jobs) and now also drives the
 * masthead's New photo button — the one place that action lives now that
 * it's been moved out of the per-face button rows (req 6: relocated so it
 * can't be mistaken for one more editing option next to Download/Add surface).
 */
function setHasImage(hasImage) {
  document.body.classList.toggle("has-image", hasImage);
  $("newImageBtn").hidden = !hasImage;
}

/* ------------------------------------------------------------------ *
 * Client-side validation
 * ------------------------------------------------------------------ *
 * Fast feedback, nothing more. The backend re-checks size, content type and
 * magic bytes independently, and its verdict is the one that decides whether
 * a task exists. Anything rejected here would also be rejected there.
 */

function validateFile(file) {
  if (!file) return "Choose an image to start.";
  if (!CONFIG.ALLOWED_CONTENT_TYPES.includes(file.type)) {
    const kinds = CONFIG.ALLOWED_CONTENT_TYPES
      .map((t) => t.replace("image/", "").toUpperCase())
      .join(", ");
    return `That file is ${file.type || "an unrecognised type"}. Use ${kinds}.`;
  }
  if (file.size > CONFIG.MAX_FILE_SIZE_BYTES) {
    return `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(CONFIG.MAX_FILE_SIZE_BYTES)}.`;
  }
  return null;
}

/** Replaces validatePrompt: there is no free text to check any more, only
 *  whether the two fixed choices are coherent. */
function validateJob() {
  if (!CONFIG.OPERATIONS.includes(session.operation)) {
    return "Choose how the surface should be found.";
  }
  if (session.operation === "Segment" && !CONFIG.SEGMENT_MODES.includes(session.mode)) {
    return "Choose interior or exterior.";
  }
  return null;
}

function refreshSubmitState() {
  const fileOk = session.reusingImage ? Boolean(session.originalImage) : !validateFile(session.file);
  $("submitBtn").disabled = !(fileOk && !validateJob()) || machine.is(STATE.UPLOADING);
}

/* ------------------------------------------------------------------ *
 * File selection
 * ------------------------------------------------------------------ */

function acceptFile(file) {
  const error = validateFile(file);
  setFieldError($("fileError"), error);
  $("drop").classList.toggle("has-error", Boolean(error));
  if (error) {
    session.file = null;
    refreshSubmitState();
    return;
  }

  if (session.fileUrl) URL.revokeObjectURL(session.fileUrl);
  session.file = file;
  session.fileUrl = URL.createObjectURL(file);

  // A different photo invalidates everything built over the last one: the
  // decoded original, the layers, and any label map, which belongs to a task
  // that was run against different pixels.
  session.originalImage = null;
  session.labelMap = null;
  session.taskOperation = null;
  session.taskMode = null;
  compositor.dispose();
  controls.resetPanel();
  picker.dispose();
  setHasImage(false);

  $("thumb").src = session.fileUrl;
  $("fileName").textContent = file.name;
  $("fileSize").textContent = formatBytes(file.size);
  $("dropBody").hidden = true;
  $("dropFile").hidden = false;
  refreshSubmitState();
  renderTaskList();
}

function clearFile() {
  if (session.fileUrl) URL.revokeObjectURL(session.fileUrl);
  session.file = null;
  session.fileUrl = null;
  $("file").value = "";
  $("dropBody").hidden = false;
  $("dropFile").hidden = true;
  setFieldError($("fileError"), null);
  refreshSubmitState();
}

/** Decode the uploaded bytes once and hand them to the compositor. */
async function ensureOriginalDecoded() {
  if (session.originalImage) return session.originalImage;
  session.originalImage = await loadImageFromBlob(session.file);
  compositor.setOriginal(session.originalImage);
  return session.originalImage;
}

/* ------------------------------------------------------------------ *
 * Submit
 * ------------------------------------------------------------------ */

async function handleSubmit(event) {
  event?.preventDefault();

  const jobError = validateJob();
  setFieldError($("jobError"), jobError);
  if (jobError) return;

  if (!session.reusingImage) {
    const fileError = validateFile(session.file);
    setFieldError($("fileError"), fileError);
    if (fileError) return;
  }

  // A fresh key per user-initiated submit. api.js reuses it across its own
  // network retries, so a dropped connection retries the same task rather
  // than creating a second one. The server's dedup window is scoped to
  // operation+mode, so changing either and resubmitting needs a new key —
  // which it gets, because this runs per submit.
  session.idempotencyKey = newIdempotencyKey();

  const job = { operation: session.operation, mode: session.mode };
  machine.to(STATE.UPLOADING, job);
  refreshSubmitState();

  try {
    const { requestId, correlationId } = await submitTask(session.file, job, {
      idempotencyKey: session.idempotencyKey,
    });
    session.requestId = requestId;
    session.correlationId = correlationId;
    session.taskOperation = job.operation;
    session.taskMode = job.operation === "Segment" ? job.mode : null;

    // Decode the original now, while the backend works, so the moment the
    // result lands there is nothing left to wait for.
    await ensureOriginalDecoded();

    machine.to(STATE.TRACKING, { requestId, correlationId });
    startTracking();
  } catch (err) {
    handleFailure(err, { during: "submit" });
  }
}

/* ------------------------------------------------------------------ *
 * Tracking (was "Polling" — see state.js and §2 of the migration notes)
 * ------------------------------------------------------------------ *
 * The backend now pushes status changes over SignalR instead of the client
 * pulling them on a timer. The one-shot pollStatus() REST call is still
 * used, but only at the two moments a push genuinely cannot be relied on:
 * right after joining (the task may already be done, and the hub only
 * pushes *changes*) and right after a reconnect (whatever changed while
 * disconnected was never replayed). Both call the same catchUpStatus().
 */

function stateLabel(state, operation) {
  switch (state) {
    case TASK_STATES.PENDING: return "Queued";
    case TASK_STATES.PREPROCESSING: return "Reading the photo";
    case TASK_STATES.PROCESSING:
      return operation === "Regions" ? "Splitting the photo into regions" : "Finding the wall";
    case TASK_STATES.COMPLETED: return "Done";
    case TASK_STATES.FAILED: return "Failed";
    default: return state;
  }
}

/**
 * Purely cosmetic companion to stateLabel(): lights up the step trail and
 * fill bar in the tracking card. Reads the same state, so it can never drift
 * from what statusLabel already says. Safe to call even when the tracking
 * card is not the visible one — it only ever touches its own nodes.
 */
const TRACKING_STEP_ORDER = [TASK_STATES.PENDING, TASK_STATES.PREPROCESSING, TASK_STATES.PROCESSING];
function setTrackingStep(state, operation) {
  const steps = document.querySelectorAll("#pollSteps .step");
  const lastLabel = $("pollStepLastLabel");
  if (lastLabel) {
    lastLabel.textContent = operation === "Regions" ? "Splitting into regions" : "Finding surface";
  }
  const idx = state === TASK_STATES.COMPLETED
    ? TRACKING_STEP_ORDER.length
    : TRACKING_STEP_ORDER.indexOf(state);
  steps.forEach((node, i) => {
    node.classList.toggle("is-done", idx > i);
    node.classList.toggle("is-active", idx === i);
  });
  const fill = $("pollFill");
  if (fill) {
    const pct = idx < 0 ? 8 : Math.min(100, ((idx + 1) / (TRACKING_STEP_ORDER.length + 0.35)) * 100);
    fill.style.width = `${pct}%`;
  }
}

/**
 * Lazily opens the one SignalR connection for the tab and wires its two
 * event handlers. Safe to call repeatedly — every caller awaits the same
 * in-flight promise rather than racing to start the connection twice.
 */
function connectHub() {
  if (hubConnection) return hubConnectPromise;

  hubConnection = new signalR.HubConnectionBuilder()
    .withUrl(apiHubUrl())
    .withAutomaticReconnect()
    .build();

  hubConnection.on("StatusChanged", (status) => {
    // A push for a task that isn't the one on screen (a stale connection
    // from a task just left, say) is simply ignored rather than treated as
    // an error — see the machine.is()/requestId guard inside applyStatus().
    applyStatus(normalizeHubStatus(status));
  });

  // Reconnecting only re-establishes the *connection* — it does not replay
  // whatever changed while disconnected (§2.2). Catching up here is the one
  // step that keeps this from regressing behind the old poll loop, which
  // self-healed every cycle by construction.
  hubConnection.onreconnected(() => {
    if (machine.is(STATE.TRACKING) && session.requestId) catchUpStatus();
  });

  hubConnectPromise = hubConnection.start().catch((err) => {
    // Leave hubConnection set so a retry reuses the same instance's own
    // retry/backoff rather than piling up dead connections; clear the
    // promise so the next connectHub() call tries start() again.
    hubConnectPromise = null;
    throw err;
  });
  return hubConnectPromise;
}

/** Absolute URL for the hub, built the same way apiUrl() builds a REST path. */
function apiHubUrl() {
  return `${CONFIG.API_BASE_URL.replace(/\/+$/, "")}${CONFIG.SIGNALR_HUB_PATH}`;
}

/** The hub's push shape is assumed identical to pollStatus()'s return shape
 *  (§2.1) — this exists as one seam to adjust in if that assumption turns
 *  out wrong, rather than a real transformation today. */
function normalizeHubStatus(status) {
  return {
    operation: status?.operation ?? null,
    mode: status?.mode ?? null,
    state: status?.state,
    isTerminal: status?.isTerminal ?? (status?.state === TASK_STATES.COMPLETED || status?.state === TASK_STATES.FAILED),
    updatedAtUtc: status?.updatedAtUtc ?? null,
    errorMessage: status?.errorMessage ?? null,
    resultUrl: status?.resultUrl ?? null,
  };
}

/** One-shot REST fetch used only for catch-up (§2.1, §2.2) — never scheduled
 *  again by itself, unlike the old pollOnce(). */
async function catchUpStatus() {
  if (!machine.is(STATE.TRACKING) || !session.requestId) return;
  try {
    const status = await pollStatus(session.requestId);
    applyStatus(status);
  } catch (err) {
    // Auth is the one failure worth surfacing here — everything else just
    // waits for the next push or the hard timeout, same as a dropped poll
    // used to.
    if (err instanceof ApiError && err.kind === "auth") {
      stopTracking();
      handleFailure(err, { during: "tracking" });
    }
  }
}

/** Shared by catchUpStatus() and the hub's "StatusChanged" handler — same UI
 *  update either way, since both carry the same shape (§2.1). */
function applyStatus(status) {
  if (!machine.is(STATE.TRACKING) || !status?.state) return;

  if (status.operation) session.taskOperation = status.operation;
  if (status.mode !== null) session.taskMode = status.mode;

  $("statusLabel").textContent = stateLabel(status.state, session.taskOperation);
  setTrackingStep(status.state, session.taskOperation);

  if (status.state === TASK_STATES.COMPLETED) {
    stopTracking();
    leaveCurrentTaskGroup();
    loadResult();
    return;
  }
  if (status.state === TASK_STATES.FAILED) {
    stopTracking();
    leaveCurrentTaskGroup();
    showTaskFailed(status.errorMessage);
  }
}

async function startTracking({ extend = false } = {}) {
  if (!extend) {
    session.trackingStartedAt = Date.now();
    session.hardDeadline = session.trackingStartedAt + CONFIG.TRACKING_HARD_TIMEOUT_MS;
    $("slowNote").hidden = true;
    $("statusLabel").textContent = stateLabel(TASK_STATES.PENDING, session.taskOperation);
    $("wellWorking").textContent = session.taskOperation === "Regions"
      ? "Splitting the photo into regions…"
      : "Finding the wall…";
    setTrackingStep(TASK_STATES.PENDING, session.taskOperation);
  } else {
    session.hardDeadline = Date.now() + CONFIG.TRACKING_EXTENSION_MS;
  }

  clearInterval(session.clockTimer);
  session.clockTimer = setInterval(tickClock, 1000);
  tickClock();

  const requestId = session.requestId;
  try {
    await connectHub();
    if (!machine.is(STATE.TRACKING) || session.requestId !== requestId) return; // stale by the time this resolves
    await hubConnection.invoke("JoinTaskGroup", requestId);
  } catch (err) {
    // The connection itself failing to open is a network problem, not a
    // task problem — the hard timeout below still catches a task that never
    // gets a hub connection at all.
    stopTracking();
    handleFailure(new ApiError("network", "Could not open a connection to track this job."), { during: "tracking" });
    return;
  }

  // Step 2 of §2.1: one REST read right after joining, because the task may
  // already have reached a terminal state — or any state at all — between
  // submission and the hub connection completing, and the hub only pushes
  // *changes* from here on, not current state on join.
  await catchUpStatus();
}

function stopTracking() {
  clearInterval(session.clockTimer);
  session.clockTimer = null;
}

/** Best-effort hygiene, not correctness: nothing breaks if this fails
 *  (a closed connection, an already-left group), so it's fire-and-forget
 *  rather than something callers need to await or handle. */
function leaveCurrentTaskGroup() {
  if (!hubConnection || hubConnection.state !== "Connected" || !session.requestId) return;
  hubConnection.invoke("LeaveTaskGroup", session.requestId).catch(() => {});
}

function tickClock() {
  const elapsed = Date.now() - session.trackingStartedAt;
  const seconds = Math.floor(elapsed / 1000);
  $("pollElapsed").textContent =
    seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (Date.now() > session.hardDeadline) {
    stopTracking();
    showHardTimeout();
    return;
  }
  // Soft timeout: change the words, keep tracking.
  if (elapsed > CONFIG.TRACKING_SOFT_TIMEOUT_MS) $("slowNote").hidden = false;
}

/* ------------------------------------------------------------------ *
 * Reading the result
 * ------------------------------------------------------------------ *
 * The same bytes, read two ways. `operation` decides which — never the shape
 * of the image, which is indistinguishable between a mask and a label map.
 */

async function loadResult({ restoreGroups = false } = {}) {
  try {
    // On a resumed, already-completed session nothing has tracked this task
    // in this tab yet, so ask once.
    if (!session.taskOperation) {
      const status = await pollStatus(session.requestId);
      session.taskOperation = status.operation;
      session.taskMode = status.mode;
    }

    const regions = session.taskOperation === "Regions";
    $("statusLabel").textContent = regions ? "Loading the regions" : "Loading the mask";
    setTrackingStep(TASK_STATES.COMPLETED, session.taskOperation);

    const blob = await fetchResult(session.requestId);
    const image = await loadImageFromBlob(blob);

    if (regions) await adoptLabelMap(image, { restoreGroups });
    else adoptSegmentMask(image);
  } catch (err) {
    if (err?.message === "MASK_TAINTED") {
      showError({
        title: t("error.resultUnreadable.title"),
        message: t("error.resultUnreadable.message"),
        detail: "SecurityError: tainted canvas",
        primary: { label: t("error.tryAgain"), action: () => { machine.to(STATE.TRACKING); loadResult(); } },
        secondary: { label: t("error.newImage"), action: resetAll },
      });
      return;
    }
    handleFailure(err, { during: "result" });
  }
}

/** Segment: the bytes are a mask, and a mask is already a layer. */
function adoptSegmentMask(maskImage) {
  const label = describeJob("Segment", session.taskMode);
  const layer = compositor.addLayer({
    id: `${session.requestId}:${session.layerSeq += 1}`,
    label,
    maskImage,
  });

  if (layer.coverage < 0.0005) {
    // The job succeeded and found essentially nothing. With no prompt to
    // blame, the useful lever is the other mode — an interior model run
    // against a facade is exactly how this happens.
    compositor.removeLayer(layer.id);
    const other = CONFIG.SEGMENT_MODES.find((m) => m !== session.taskMode) ?? null;
    showError({
      title: t("error.noWallFound.title"),
      message: t("error.noWallFound.message", { mode: session.taskMode ?? "" })
        + (other ? t("error.noWallFound.otherHint", { other }) : ""),
      primary: other
        ? {
            label: t("error.noWallFound.tryOtherInstead", { other }),
            action: () => {
              session.mode = other;
              syncJobInputs();
              backToForm({ reuseImage: true });
              handleSubmit();
            },
          }
        : { label: t("error.tryAgain"), action: () => { backToForm({ reuseImage: true }); handleSubmit(); } },
      secondary: { label: t("error.noWallFound.pickByHand"), action: () => switchToRegions() },
    });
    return;
  }

  session.reusingImage = true;
  setHasImage(true);
  machine.to(STATE.READY, { requestId: session.requestId });
  setReadyFace("edit");
  controls.setActiveLayer(layer.id);
  controls.refresh();
  compositor.render();
  updateReadout();
  toast(t("select.readyToEdit", { label }));
}

/** Regions: the bytes are a label map, which is raw material, not a mask. */
async function adoptLabelMap(labelImage, { restoreGroups }) {
  const map = createLabelMap(labelImage);

  if (map.regionCount === 0 || map.labelledFraction < 0.0005) {
    // Rarer and different from "no wall found": the model produced no
    // regions at all, so there is nothing to click. Retrying the same photo
    // is unlikely to help.
    showError({
      title: t("error.noRegions.title"),
      message: t("error.noRegions.message"),
      primary: { label: t("error.newImage"), action: resetAll },
      secondary: { label: t("error.noRegions.findAutomatically"), action: () => switchToSegment() },
    });
    return;
  }

  session.labelMap = map;
  session.reusingImage = true;
  setHasImage(true);
  machine.to(STATE.READY, { requestId: session.requestId });

  picker.mount(session.originalImage, map);
  // Materializes every saved group as a layer (syncGroupLayers, inside
  // refreshGroups) — first load and resume both go through this same path
  // now, so "land on edit with every surface visible" is one rule rather
  // than a resume-only special case (req 4).
  await refreshGroups({ quiet: true });

  const hasSurfaces = compositor.layers.length > 0;
  if (hasSurfaces) {
    setReadyFace("edit");
    controls.refresh();
    compositor.render();
    if (restoreGroups) {
      toast(t("select.savedSelectionsRestored", {
        count: compositor.layers.length,
        plural: compositor.layers.length === 1 ? "" : "s",
      }));
    }
  } else {
    setReadyFace("select");
    resetSelectionForm();
    toast(t("select.regionsFound", { count: map.regionCount }));
  }
  updateReadout();
}

/* ------------------------------------------------------------------ *
 * Region selection → layer
 * ------------------------------------------------------------------ */

function onSelectionChange(selection) {
  const count = selection.size;
  $("selCount").textContent = t("select.regionsCount", { count, plural: count === 1 ? "" : "s" });
  $("selCoverage").textContent = t("select.coveragePercent", { percent: (picker.coverage() * 100).toFixed(1) });

  const chips = $("selChips");
  chips.innerHTML = "";
  for (const id of selection) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.title = t("select.removeRegionTitle");
    const x = document.createElement("span");
    x.className = "chip__x";
    x.textContent = "×";
    chip.append(document.createTextNode(`#${id}`), x);
    chip.addEventListener("click", () => {
      const next = picker.selection;
      next.delete(id);
      picker.setSelection(next);
    });
    chips.append(chip);
  }

  refreshSelectionUi();
}

function refreshSelectionUi() {
  const count = picker.size;
  const named = $("groupName").value.trim().length > 0;
  $("useSelectionBtn").disabled = count === 0;
  $("clearSelBtn").disabled = count === 0;
  $("saveGroupBtn").disabled = count === 0 || !named || session.groupWriteInFlight;
  $("editingNote").hidden = !session.editingGroupId;
  $("saveGroupBtn").querySelector(".btn__label").textContent =
    session.editingGroupId ? "Update selection" : "Save selection";
}

function resetSelectionForm() {
  session.editingGroupId = null;
  session.draftLayerId = null;
  $("groupName").value = "";
  setFieldError($("groupError"), null);
  picker.clear();
  refreshSelectionUi();
}

/**
 * Turn the pending selection into an editable layer. Deliberately not gated
 * behind saving: saving is about getting a selection back tomorrow, and
 * making it a precondition for editing would mean a round trip — and a hit on
 * a rate limit sized for uploads — before the user can see a colour.
 *
 * Reuses one layer id across repeated clicks rather than minting a new one
 * every time (req 4 — every possible surface stays visible, with no
 * duplicates piling up as a selection gets refined):
 *   - editing an existing saved group → `group:{id}`, updated in place
 *   - a selection with no group yet → a stable per-session draft id,
 *     likewise updated in place until it's either saved (see saveGroup,
 *     which reconciles the draft id to the real group id) or abandoned
 *     (see resetSelectionForm, which drops the draft id so the *next*
 *     "Edit these regions" starts a genuinely new surface instead of
 *     silently overwriting the old one).
 */
function useSelection({ name } = {}) {
  const selection = picker.selection;
  if (!selection.size || !session.labelMap) return null;

  const { canvas, coverage } = session.labelMap.toMask(selection);
  const label = name || $("groupName").value.trim() || `Selection ${session.layerSeq + 1}`;

  let id;
  if (session.editingGroupId) {
    id = `group:${session.editingGroupId}`;
  } else {
    if (!session.draftLayerId) session.draftLayerId = `draft:${session.layerSeq += 1}`;
    id = session.draftLayerId;
  }

  const layer = compositor.getLayer(id)
    ? compositor.updateLayerSource(id, { mask: canvas, coverage, label })
    : compositor.addLayer({ id, label, mask: canvas, coverage });

  setReadyFace("edit");
  controls.setActiveLayer(layer.id);
  controls.refresh();
  compositor.render();
  updateReadout();
  return layer;
}

/** Restore a saved group straight to a layer, without touching the picker.
 *  Updates in place if a layer already exists for this group — e.g. a draft
 *  that saveGroup() just reconciled to this id, or a previous sync pass —
 *  rather than ever creating a second layer for the same saved group. */
function addLayerFromGroup(group) {
  if (!session.labelMap || !group?.regionIds?.length) return null;
  const { canvas, coverage } = session.labelMap.toMask(group.regionIds);
  if (coverage <= 0) return null;
  const id = `group:${group.id}`;
  const label = group.name || "Saved selection";
  return compositor.getLayer(id)
    ? compositor.updateLayerSource(id, { mask: canvas, coverage, label })
    : compositor.addLayer({ id, label, mask: canvas, coverage });
}

/**
 * Every saved group is an editable surface, always — not just the ones the
 * user explicitly turned into a layer with "Edit these regions" (req 4: all
 * possible surfaces stay visible in the editor, all the time). Called after
 * every successful group-list fetch, so this covers first load, resume, and
 * a fresh save all the same way, with one rule: never touch a layer that's
 * already there for a given group id (addLayerFromGroup already handles
 * "update in place" for that case).
 */
function syncGroupLayers() {
  if (!session.labelMap) return false;
  let changed = false;
  for (const group of session.groups) {
    if (addLayerFromGroup(group)) changed = true;
  }
  return changed;
}

/* ------------------------------------------------------------------ *
 * Saved selections (mask groups)
 * ------------------------------------------------------------------ */

async function refreshGroups({ quiet = false } = {}) {
  if (!session.requestId || session.taskOperation !== "Regions") return;
  try {
    session.groups = await listMaskGroups(session.requestId);
  } catch (err) {
    // Non-fatal: the label map is already usable, and a 404 here is genuinely
    // ambiguous between "no such task" and "not yours" by design.
    session.groups = [];
    if (!quiet) setFieldError($("groupError"), "Saved selections could not be loaded.");
  }
  if (syncGroupLayers()) {
    controls.refresh();
    compositor.render();
    updateReadout();
  }
  renderGroups();
}

function renderGroups() {
  const list = $("groupList");
  list.innerHTML = "";
  $("groupEmpty").hidden = session.groups.length > 0;

  for (const group of session.groups) {
    const item = document.createElement("li");
    item.className = "groupitem";

    const icon = document.createElement("span");
    icon.className = "groupitem__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = group.name.trim().charAt(0).toUpperCase() || "?";

    const main = document.createElement("div");
    main.className = "groupitem__main";
    const name = document.createElement("span");
    name.className = "groupitem__name";
    name.textContent = group.name;
    const meta = document.createElement("span");
    meta.className = "groupitem__meta";
    meta.textContent = `${group.regionIds.length} region${group.regionIds.length === 1 ? "" : "s"}`;
    main.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "groupitem__actions";

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "chipbtn";
    edit.textContent = t("common.open");
    edit.addEventListener("click", () => openGroup(group));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "chipbtn chipbtn--danger";
    remove.textContent = t("common.delete");
    remove.addEventListener("click", () => removeGroup(group, remove));

    actions.append(edit, remove);
    item.append(icon, main, actions);
    list.append(item);
  }
}

/** Load a saved group back into the picker for adjustment. */
function openGroup(group) {
  session.editingGroupId = group.id;
  $("groupName").value = group.name;
  picker.setSelection(group.regionIds);
  setReadyFace("select");
  refreshSelectionUi();
}

/**
 * One writer for all three group verbs.
 *
 * This endpoint takes no Idempotency-Key, so a retried POST is a duplicate
 * group rather than the same group twice — which makes the in-flight guard
 * the only thing standing between a double-click and two identical saves.
 * The interval floor covers the second half of that: a click landing just
 * after a response, before the UI has caught up.
 */
async function withGroupWrite(button, fn) {
  if (session.groupWriteInFlight) return null;
  if (Date.now() - session.lastGroupWriteAt < CONFIG.GROUP_WRITE_MIN_INTERVAL_MS) return null;

  session.groupWriteInFlight = true;
  button.disabled = true;
  button.classList.add("is-busy");
  setFieldError($("groupError"), null);
  try {
    return await fn();
  } catch (err) {
    const api = err instanceof ApiError ? err : new ApiError("unknown", err?.message);
    // Auth and rate limiting need the full-screen treatment (sign-in, or a
    // countdown). Everything else stays inline so the selection survives.
    if (api.kind === "auth" || api.kind === "rate_limit") handleFailure(api, { during: "group" });
    else setFieldError($("groupError"), api.message || "That could not be saved.");
    return null;
  } finally {
    session.groupWriteInFlight = false;
    session.lastGroupWriteAt = Date.now();
    button.classList.remove("is-busy");
    refreshSelectionUi();
  }
}

async function saveGroup() {
  const button = $("saveGroupBtn");
  const name = $("groupName").value.trim();
  const regionIds = [...picker.selection];
  if (!name || !regionIds.length) return;

  const saved = await withGroupWrite(button, () =>
    session.editingGroupId
      ? updateMaskGroup(session.requestId, session.editingGroupId, { name, regionIds })
      : createMaskGroup(session.requestId, { name, regionIds }));

  if (!saved) return;

  // The layer standing in for this selection — if one exists yet — was
  // tracked under a temporary draft id. Now that the group is real, that
  // layer *is* the group: rename it rather than letting the next sync pass
  // add a second, identical-looking surface alongside it.
  const groupLayerId = `group:${saved.id}`;
  if (session.draftLayerId && session.draftLayerId !== groupLayerId) {
    compositor.renameLayer(session.draftLayerId, groupLayerId);
    session.draftLayerId = null;
  }
  const layer = compositor.getLayer(groupLayerId);
  if (layer) layer.label = name; // keep the surface's label in step with the name just saved

  session.editingGroupId = saved.id ?? session.editingGroupId;
  await refreshGroups(); // also covers the "never clicked Edit these regions" case, via syncGroupLayers
  controls.refresh();
  compositor.render();
  toast(t("select.savedGroup", { name }));
}

async function removeGroup(group, button) {
  if (!window.confirm(`Delete “${group.name}”?`)) return;
  const done = await withGroupWrite(button, async () => {
    await deleteMaskGroup(session.requestId, group.id);
    return true;
  });
  if (!done) return;
  if (session.editingGroupId === group.id) resetSelectionForm();
  // A layer built from this group stays where it is — deleting the saved
  // selection is about the server's copy, not about undoing an edit.
  await refreshGroups();
  toast(t("select.selectionDeleted"));
}

/* ------------------------------------------------------------------ *
 * Resuming an earlier session
 * ------------------------------------------------------------------ */

let taskList = [];

async function refreshTaskList() {
  const button = $("resumeRefresh");
  button.disabled = true;
  try {
    taskList = await listImages();
    renderTaskList();
  } catch (err) {
    const api = err instanceof ApiError ? err : new ApiError("unknown", err?.message);
    if (api.kind === "auth") handleFailure(api, { during: "list" });
    else {
      taskList = [];
      renderTaskList();
      toast(api.message || t("error.jobListFailed"));
    }
  } finally {
    button.disabled = false;
  }
}

/** requestId currently shown in the free-canvas preview, or null. Module
 *  scope: renderTaskList() reads it to highlight the right row, and it
 *  outlives any single render pass since the list can refresh while a
 *  preview is showing. */
let previewingRequestId = null;

function renderTaskList() {
  const list = $("resumeList");
  if (!list) return;
  list.innerHTML = "";
  $("resumeEmpty").hidden = taskList.length > 0;

  for (const task of taskList) {
    const item = document.createElement("li");
    item.className = "taskitem";
    if (previewingRequestId === task.requestId) item.classList.add("taskitem--active");

    // A real <button>, not a <div> with a click listener: this is the part
    // of the row that toggles the preview, and it needs to be its own
    // focusable, keyboard-operable control distinct from "Open" — clicking
    // it is a look, not a commitment, so it deliberately does less.
    const main = document.createElement("button");
    main.type = "button";
    main.className = "taskitem__main";
    main.setAttribute("aria-pressed", String(previewingRequestId === task.requestId));
    const name = document.createElement("span");
    name.className = "taskitem__name";
    name.textContent = describeJob(task.operation, task.mode);
    const meta = document.createElement("span");
    meta.className = "taskitem__meta";
    const when = task.createdAtUtc ? new Date(task.createdAtUtc).toLocaleString() : "";
    meta.textContent = `${task.state}${when ? ` · ${when}` : ""}`;
    main.append(name, meta);
    main.addEventListener("click", () => toggleTaskPreview(task));

    const open = document.createElement("button");
    open.type = "button";
    open.className = "btn btn--quiet";
    open.textContent = t("common.open");
    // Always enabled, and always a complete resume in one click — GET
    // /original returns the actual uploaded photo for any task, in any
    // state, so there's nothing left to wait on the person to provide.
    // Deliberately separate from the preview above: this is the action that
    // commits to actually editing the session, not just looking at it.
    open.addEventListener("click", () => openTask(task));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn btn--quiet linkbtn--danger taskitem__del";
    del.textContent = t("common.delete");
    del.setAttribute("aria-label", `${t("common.delete")} ${describeJob(task.operation, task.mode)}`);
    del.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteTask(task, del);
    });

    item.append(main, open, del);
    list.append(item);
  }
}

/**
 * New: `DELETE /api/images/{id}` did not exist before this migration. This
 * is destructive with no undo, so it always confirms first, the same
 * pattern removeGroup() already uses for deleting a saved selection.
 *
 * The row this button lives on is only reachable from the resume panel,
 * which only shows while `#jobForm` is visible — idle or uploading (see
 * index.html's `data-when` on that form). A task actively open in the
 * editor (tracking/ready/error) has no delete button anywhere on screen, so
 * "delete the session currently open in the stage" cannot happen from here.
 * It *can* still happen that `session.requestId` refers to a task just
 * deleted from the list after backing out of it via "New photo" — in that
 * case the local session state for it is cleared below so nothing later
 * tries to act on a task the server no longer has.
 */
async function deleteTask(task, button) {
  if (!window.confirm(`Delete this ${describeJob(task.operation, task.mode)} job? This cannot be undone.`)) {
    return;
  }
  button.disabled = true;
  try {
    await deleteImage(task.requestId);
  } catch (err) {
    button.disabled = false;
    const api = err instanceof ApiError ? err : new ApiError("unknown", err?.message);
    if (api.kind === "auth") {
      auth.resumeAction = () => { machine.to(STATE.IDLE); refreshTaskList(); };
      showAuth("login");
      return;
    }
    toast(api.message || t("error.deleteJobFailed"));
    return;
  }

  taskList = taskList.filter((t) => t.requestId !== task.requestId);
  if (previewingRequestId === task.requestId) hideTaskPreview();
  if (session.requestId === task.requestId) {
    session.requestId = null;
    session.lastOpenAttempt = null;
  }
  renderTaskList();
  toast(t("select.jobDeleted"));
}

/**
 * Show or hide a quick look at a saved session's photo on the free canvas,
 * without touching anything else — no tracking, no groups, no compositor
 * state. Clicking the same row again turns it back off; clicking a
 * different row switches straight to that one.
 */
async function toggleTaskPreview(task) {
  if (previewingRequestId === task.requestId) {
    previewingRequestId = null;
    hideTaskPreview();
    renderTaskList();
    return;
  }
  previewingRequestId = task.requestId;
  renderTaskList();

  $("taskPreviewLabel").textContent = describeJob(task.operation, task.mode);
  $("taskPreviewWrap").hidden = false;
  $("emptyDefault").hidden = true;

  const canvas = $("taskPreviewCanvas");
  try {
    const blob = await fetchOriginal(task.requestId);
    // Stale guard: if another row was clicked while this was in flight,
    // don't paint the wrong photo over whatever's being previewed now.
    if (previewingRequestId !== task.requestId) return;
    const img = await loadImageFromBlob(blob);
    if (previewingRequestId !== task.requestId) return;
    const maxEdge = 340;
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  } catch {
    // Non-fatal: this is a quick look, not a load-bearing step. Open still
    // does a full, independent fetch of its own either way.
  }
}

function hideTaskPreview() {
  previewingRequestId = null;
  $("taskPreviewWrap").hidden = true;
  $("emptyDefault").hidden = false;
}

/**
 * Reopen a saved session. Fetches the real photo via GET /original — which
 * works regardless of the task's state, including Failed — decodes it
 * straight into the compositor, and only then figures out what to do with
 * whatever state the task is actually in. A Completed task loads its result
 * normally; a Failed one shows the error screen with the photo that was
 * attempted still visible behind it, which is exactly the case the backend
 * built this endpoint for; anything still in flight just resumes tracking.
 */
async function openTask(task) {
  hideTaskPreview();
  leaveCurrentTaskGroup(); // whatever task's group this tab was joined to, it's about to be a different one
  session.lastOpenAttempt = task;
  session.requestId = task.requestId;
  session.correlationId = null;
  session.taskOperation = task.operation;
  session.taskMode = task.mode;
  session.labelMap = null;
  session.groups = [];
  session.editingGroupId = null;
  session.draftLayerId = null;
  // dispose() clears the compositor's original as well, so the decoded image
  // has to be handed back to it — hence dropping the cached one first. There
  // is no local File object for a resumed session either way: the photo
  // comes from the network now, not from a picker.
  compositor.dispose();
  controls.resetPanel();
  session.originalImage = null;
  session.file = null;
  if (session.fileUrl) {
    URL.revokeObjectURL(session.fileUrl);
    session.fileUrl = null;
  }

  machine.to(STATE.UPLOADING);
  try {
    const blob = await fetchOriginal(task.requestId);
    session.originalImage = await loadImageFromBlob(blob);
    compositor.setOriginal(session.originalImage);
  } catch (err) {
    handleFailure(err, { during: "original" });
    return;
  }

  // The photo is real and decoded — show it now, regardless of what happens
  // next. setReadyFace("edit") plus has-image is what makes the stage keep
  // showing a photo across states that normally wouldn't (error, tracking);
  // see body.has-image in styles.css.
  setHasImage(true);
  setReadyFace("edit");
  compositor.render();

  machine.to(STATE.TRACKING, { requestId: task.requestId });

  if (task.state === TASK_STATES.COMPLETED) {
    $("statusLabel").textContent = t("tracking.reopeningSession");
    setTrackingStep(TASK_STATES.COMPLETED, task.operation);
    await loadResult({ restoreGroups: true });
  } else if (task.state === TASK_STATES.FAILED) {
    // listImages() doesn't carry errorMessage — only /status does — so this
    // still falls back to showTaskFailed's generic copy rather than the
    // task's actual failure reason. The photo behind it is the real
    // improvement here regardless.
    showTaskFailed(null);
  } else {
    startTracking();
  }
}

/* ------------------------------------------------------------------ *
 * Errors and recovery
 * ------------------------------------------------------------------ */

/**
 * Show an error screen. `primary` and `secondary` carry the recovery that
 * actually fits the failure — a rate limit gets a countdown, an auth failure
 * gets a sign-in, a failed task gets a resubmit. A single "Try again" for
 * everything would be a lie in at least three of these cases.
 */
function showError({ title, message, detail = null, primary, secondary = null, correlationId = null }) {
  $("errorTitle").textContent = title;
  $("errorMessage").textContent = message;

  // Technical detail and correlation ids are no longer shown in the UI (req
  // 1) — a person trying to repaint a wall doesn't need "HTTP 409" or a
  // correlation id, and the plain-language message above is the whole
  // point. Still logged, so a real debugging session isn't left with
  // nothing: open devtools and it's right there.
  const correlation = correlationId || session.correlationId;
  if (detail || correlation) {
    console.debug("[maskwork error]", { title, detail, correlationId: correlation });
  }

  const primaryBtn = $("errPrimary");
  primaryBtn.textContent = primary?.label ?? "Try again";
  primaryBtn.disabled = false;
  primaryBtn.onclick = primary?.action ?? resetAll;

  const secondaryBtn = $("errSecondary");
  if (secondary) {
    secondaryBtn.hidden = false;
    secondaryBtn.textContent = secondary.label;
    secondaryBtn.onclick = secondary.action;
  } else {
    secondaryBtn.hidden = true;
    secondaryBtn.onclick = null;
  }

  clearInterval(session.countdownTimer);
  machine.to(STATE.ERROR);
  updateReadout();
}

/** Back to whichever ready face the user was on — used by recoveries that
 *  interrupted work rather than ending it. If there is no work to go back to
 *  (a failure while listing jobs from the idle form, say), the form is the
 *  honest destination: IDLE → READY is not a transition the machine allows,
 *  and forcing it would land on an empty editor. */
function backToWork() {
  if (!compositor.layers.length && !session.labelMap) {
    backToForm({ reuseImage: session.reusingImage });
    return;
  }
  machine.to(STATE.READY);
  setReadyFace(document.body.dataset.ready === "select" ? "select" : "edit");
  updateReadout();
}

/** Map an ApiError onto a screen. One place, so the wording stays consistent. */
function handleFailure(err, { during }) {
  const api = err instanceof ApiError ? err : new ApiError("unknown", err?.message || "Unexpected error.");
  const resubmit = () => { backToForm({ reuseImage: session.reusingImage }); handleSubmit(); };

  switch (api.kind) {
    case "validation":
      // No task was created — send the user back to the form, not to an
      // error screen they have to click out of.
      machine.to(STATE.IDLE);
      setFieldError($("fileError"), api.detail || "The server rejected this file.");
      $("drop").classList.add("has-error");
      refreshSubmitState();
      toast(t("error.uploadRejected"));
      return;

    case "auth":
      // The token is missing or expired (§1.1) — not something a plain
      // retry fixes. Land on the login screen; whichever action was in
      // flight resumes automatically once sign-in completes, via
      // auth.resumeAction/completeAuth() rather than a modal prompt.
      auth.resumeAction = () => {
        if (during === "tracking" && session.requestId) {
          machine.to(STATE.TRACKING);
          startTracking();
        } else if (during === "result") {
          machine.to(STATE.TRACKING);
          loadResult();
        } else if (during === "original" && session.lastOpenAttempt) {
          openTask(session.lastOpenAttempt);
        } else if (during === "list") {
          machine.to(STATE.IDLE);
          refreshTaskList();
        } else if (during === "group") {
          backToWork();
        } else {
          resubmit();
        }
      };
      showAuth("login");
      setFieldError($("loginError"), "Your session is not valid for this request. Sign in again — your photo and your selection are still here.");
      return;

    case "rate_limit": {
      const seconds = api.retryAfterSeconds ?? 30;
      const group = during === "group";
      showError({
        title: t("error.rateLimited.title"),
        message: group
          ? t("error.rateLimited.messageGroup")
          : t("error.rateLimited.messageSubmit"),
        primary: { label: t("error.rateLimited.wait", { seconds }), action: () => {} },
        secondary: { label: t("error.startOver"), action: resetAll },
      });
      startCountdown(seconds, group
        ? { label: t("error.rateLimited.backToSelection"), action: backToWork }
        : { label: t("error.rateLimited.submitAgain"), action: resubmit });
      return;
    }

    case "not_ready":
      // Only reachable once fetchResult has spent its whole backoff on 409s:
      // status reported Completed, but /result still says otherwise. The job
      // is fine, so the recovery is to ask again, not to resubmit.
      showError({
        title: t("error.notReady.title"),
        message: t("error.notReady.message"),
        detail: api.detail,
        primary: { label: t("error.notReady.checkAgain"), action: () => { machine.to(STATE.TRACKING); loadResult(); } },
        secondary: { label: t("error.startOver"), action: resetAll },
      });
      return;

    case "not_found":
      showError({
        title: during === "original" ? t("error.notFound.titleSession") : t("error.notFound.titleJob"),
        message: during === "original"
          // /original's 404 is unambiguous by design (not owner-scoped), so
          // this can say something more definite than the groups/list case.
          ? t("error.notFound.messageOriginal")
          : during === "group" || during === "list"
          // Groups and the task list answer "not yours" with 404 as well, on
          // purpose, so this genuinely cannot be narrowed down for the user.
          ? t("error.notFound.messageScoped")
          : t("error.notFound.messageGeneric"),
        primary: during === "original"
          ? { label: t("error.notFound.back"), action: () => { machine.to(STATE.IDLE); refreshTaskList(); } }
          : during === "group" || during === "list"
          ? { label: t("error.notFound.back"), action: backToWork }
          : { label: t("error.rateLimited.submitAgain"), action: resubmit },
        secondary: { label: t("error.newImage"), action: resetAll },
      });
      return;

    case "network":
      showError({
        title: t("error.noConnection.title"),
        message: during === "result"
          ? t("error.noConnection.messageResult")
          : during === "original"
          ? t("error.noConnection.messageOriginal")
          : t("error.noConnection.messageGeneric"),
        detail: api.detail,
        primary: {
          label: during === "result" ? t("error.noConnection.downloadAgain") : t("error.tryAgain"),
          action: during === "result"
            ? () => { machine.to(STATE.TRACKING); loadResult(); }
            : during === "original" && session.lastOpenAttempt
            ? () => openTask(session.lastOpenAttempt)
            : resubmit,
        },
        secondary: { label: t("error.startOver"), action: resetAll },
      });
      return;

    case "aborted":
      machine.to(STATE.IDLE);
      return;

    default:
      showError({
        title: t("error.serverProblem.title"),
        message: api.message || t("error.serverProblem.message"),
        detail: api.status ? `HTTP ${api.status}` : null,
        primary: { label: t("error.tryAgain"), action: resubmit },
        secondary: { label: t("error.startOver"), action: resetAll },
      });
  }
}

/** Task reached Failed. The backend's errorMessage is shown verbatim when it
 *  reads like a sentence; otherwise it goes into the technical detail line so
 *  the user still gets plain language up top. */
function showTaskFailed(errorMessage) {
  const readable = typeof errorMessage === "string" && /\s/.test(errorMessage.trim()) && errorMessage.length > 12;
  showError({
    title: t("error.jobFailed.title"),
    message: readable
      ? errorMessage
      : t("error.jobFailed.messageGeneric", { job: describeJob(session.taskOperation, session.taskMode) }),
    detail: readable ? null : errorMessage || null,
    primary: {
      // Fresh task: new RequestId, new Idempotency-Key, same photo and settings.
      label: t("error.tryAgain"),
      action: () => { backToForm({ reuseImage: true }); handleSubmit(); },
    },
    secondary: { label: t("error.newImage"), action: resetAll },
  });
}

function showHardTimeout() {
  const minutes = Math.round(CONFIG.TRACKING_HARD_TIMEOUT_MS / 60000);
  showError({
    title: t("error.takingLong.title"),
    message: t("error.takingLong.message", { minutes }),
    detail: session.requestId ? `Request ${session.requestId}` : null,
    primary: {
      label: t("error.takingLong.keepWaiting"),
      action: () => { machine.to(STATE.TRACKING); startTracking({ extend: true }); },
    },
    secondary: { label: t("error.takingLong.stopAndStartOver"), action: resetAll },
  });
}

/** @param {{label: string, action: Function}} resume what the button becomes
 *  once the wait is over — which is not the same thing for a throttled submit
 *  as for a throttled group save. */
function startCountdown(seconds, resume) {
  let left = seconds;
  const button = $("errPrimary");
  button.disabled = true;
  clearInterval(session.countdownTimer);
  session.countdownTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(session.countdownTimer);
      button.disabled = false;
      button.textContent = resume.label;
      button.onclick = resume.action;
      return;
    }
    button.textContent = `Wait ${left}s`;
  }, 1000);
}

/* ------------------------------------------------------------------ *
 * Auth screens — login, register, 2FA, logout (§1.2 of the migration notes)
 * ------------------------------------------------------------------ *
 * Independent of the state machine: there is no task flow to be in the
 * middle of before a session exists, so this is a layer above `machine`,
 * not a state within it. #authScreen and <main> are toggled by
 * body.authed; showAuth() additionally picks which of the three forms is
 * showing via #authScreen's own data-view attribute (same pattern as
 * data-when/data-ready elsewhere in this file).
 */

function isAuthed() {
  return Boolean(getAuthToken());
}

/** Show or hide the whole auth layer versus the app underneath it. Called
 *  once at boot and again after logout; login/register/2FA success routes
 *  through completeAuth() instead, which calls this too. */
function toggleAuthed(authed) {
  document.body.classList.toggle("authed", authed);
  $("logoutBtn").hidden = !authed;
}

/** @param {"login"|"register"|"twofactor"} view */
function showAuth(view) {
  toggleAuthed(false);
  $("authScreen").dataset.view = view;
  const focusTarget = { login: "loginEmail", register: "registerEmail", twofactor: "twoFactorCode" }[view];
  $(focusTarget)?.focus();
}

function setAuthBusy(formId, busy) {
  const form = $(formId);
  form.querySelectorAll("button[type='submit']").forEach((btn) => { btn.disabled = busy; });
  form.classList.toggle("is-busy", busy);
}

/**
 * Finishes any sign-in path — password, register, 2FA, or the Google
 * callback in boot() — the same way: store the token, drop the auth layer,
 * and resume whatever was interrupted (§1.1 — a 401 mid-task lands back
 * where it was, not on an empty form). With no interrupted action, landing
 * on the idle screen and refreshing the task list is the ordinary
 * just-signed-in destination.
 */
function completeAuth(token) {
  setAuthToken(token);
  auth.twoFactorToken = null;
  toggleAuthed(true);
  const resume = auth.resumeAction;
  auth.resumeAction = null;
  if (resume) {
    resume();
  } else {
    machine.to(STATE.IDLE);
    refreshSubmitState();
    refreshTaskList();
  }
}

/** Common shape of login()/register(): either a token (done) or a
 *  twoFactorToken (one more screen). Shared so the two forms don't repeat
 *  this branch. */
function handleAuthResult(result) {
  if (result.done) {
    completeAuth(result.token);
  } else {
    auth.twoFactorToken = result.twoFactorToken;
    showAuth("twofactor");
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  setFieldError($("loginError"), null);
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  if (!email || !password) {
    setFieldError($("loginError"), "Enter your email and password.");
    return;
  }
  setAuthBusy("loginForm", true);
  try {
    handleAuthResult(await login({ email, password }));
  } catch (err) {
    const api = err instanceof ApiError ? err : new ApiError("unknown", err?.message);
    setFieldError($("loginError"), api.kind === "auth"
      ? "Wrong email or password."
      : api.message || "Could not sign in.");
  } finally {
    setAuthBusy("loginForm", false);
  }
}

async function handleRegisterSubmit(event) {
  event.preventDefault();
  setFieldError($("registerError"), null);
  const email = $("registerEmail").value.trim();
  const password = $("registerPassword").value;
  if (!email || !password) {
    setFieldError($("registerError"), "Enter an email and a password.");
    return;
  }
  setAuthBusy("registerForm", true);
  try {
    handleAuthResult(await register({ email, password }));
  } catch (err) {
    const api = err instanceof ApiError ? err : new ApiError("unknown", err?.message);
    setFieldError($("registerError"), api.kind === "validation"
      ? (api.detail || "The server rejected those details.")
      : api.message || "Could not create an account.");
  } finally {
    setAuthBusy("registerForm", false);
  }
}

async function handleTwoFactorSubmit(event) {
  event.preventDefault();
  setFieldError($("twoFactorError"), null);
  const code = $("twoFactorCode").value.trim();
  if (!auth.twoFactorToken) {
    // Landed here without a live 2FA session (e.g. a reload mid-flow) — the
    // only honest recovery is back to the start of sign-in.
    showAuth("login");
    return;
  }
  if (!/^\d{6}$/.test(code)) {
    setFieldError($("twoFactorError"), "Enter the 6-digit code.");
    return;
  }
  setAuthBusy("twoFactorForm", true);
  try {
    const { token } = await verifyTwoFactor({ twoFactorToken: auth.twoFactorToken, code });
    completeAuth(token);
  } catch (err) {
    const api = err instanceof ApiError ? err : new ApiError("unknown", err?.message);
    setFieldError($("twoFactorError"), api.kind === "auth"
      ? "That code is wrong or has expired."
      : api.message || "Could not verify that code.");
  } finally {
    setAuthBusy("twoFactorForm", false);
  }
}

/** A plain top-level navigation, not a fetch — the backend owns the whole
 *  OAuth dance and redirects back to returnUrl once it has a session (see
 *  googleLoginUrl() in api.js and the callback handling in boot()). */
function handleGoogleLogin() {
  const returnUrl = window.location.origin + window.location.pathname;
  window.location.href = googleLoginUrl(returnUrl);
}

/**
 * Stateless JWT, no refresh token implemented (see the note in boot() on
 * that decision) — there is nothing for the backend to revoke, so this is a
 * local-only sign-out. Also resets the task in progress, since it belongs
 * to an identity that is no longer the active one in this tab.
 */
function handleLogout() {
  setAuthToken(null);
  resetAll();
  taskList = [];
  auth.resumeAction = null;
  showAuth("login");
}

function wireAuth() {
  $("loginForm").addEventListener("submit", handleLoginSubmit);
  $("registerForm").addEventListener("submit", handleRegisterSubmit);
  $("twoFactorForm").addEventListener("submit", handleTwoFactorSubmit);
  $("googleLoginBtn").addEventListener("click", handleGoogleLogin);
  $("toRegister").addEventListener("click", () => showAuth("register"));
  $("toLogin").addEventListener("click", () => showAuth("login"));
  $("cancelTwoFactor").addEventListener("click", () => {
    auth.twoFactorToken = null;
    showAuth("login");
  });
  $("logoutBtn").addEventListener("click", handleLogout);
}

/* ------------------------------------------------------------------ *
 * Navigation between screens
 * ------------------------------------------------------------------ */

/** Which face of `ready` is showing. Not a machine transition — see the
 *  comment on <body> in index.html. */
function setReadyFace(face) {
  document.body.dataset.ready = face;

  if (face === "select" && session.labelMap) {
    // So switching to pick more regions never hides work already done: the
    // picker draws whatever it's handed, so handing it the compositor's own
    // live canvas (rather than the flat original) means every surface
    // painted so far stays visible underneath the region highlights (req 9).
    // Nothing to show yet (fresh photo, no layer) falls back to the plain
    // photo, which is what it would have drawn anyway.
    picker.setBackground(compositor.layers.length ? compositor.display : session.originalImage);
  }

  if (face !== "edit") {
    // Leaving the editor — start the compare view fresh next time it opens,
    // rather than reappearing mid-drag from wherever it was left.
    $("comparebox").hidden = true;
    $("compareToggle").setAttribute("aria-pressed", "false");
    $("compareSlider").value = "50";
    $("comparebox").style.setProperty("--split", "50%");
  }

  updateReadyChrome();
}

function updateReadyChrome() {
  const regions = isRegionsTask();
  const hasLayers = compositor.layers.length > 0;

  // Same button, two meanings: a Regions task already holds everything needed
  // for another surface, while a Segment task can only be pointed at the
  // other mode, which is a new job. Text goes on the label span, not the
  // button itself — the button also carries a "+" icon span now (req 5).
  $("addRegionLabel").textContent = regions ? "Choose another surface" : "Run the other mode";
  $("toEditBtn").hidden = !hasLayers;
}

function switchToRegions() {
  session.operation = "Regions";
  syncJobInputs();
  backToForm({ reuseImage: true });
}

function switchToSegment() {
  session.operation = "Segment";
  syncJobInputs();
  backToForm({ reuseImage: true });
}

function backToForm({ reuseImage = false } = {}) {
  stopTracking();
  clearInterval(session.countdownTimer);
  session.reusingImage = reuseImage && Boolean(session.originalImage);
  $("reuseNote").hidden = !session.reusingImage;
  $("drop").hidden = session.reusingImage;   // no second upload for a second job
  machine.to(STATE.IDLE);
  refreshSubmitState();
  $("submitBtn").focus();
}

function resetAll() {
  stopTracking();
  leaveCurrentTaskGroup();
  clearInterval(session.countdownTimer);
  compositor.dispose();
  controls.resetPanel();
  picker.dispose();
  if (session.fileUrl) URL.revokeObjectURL(session.fileUrl);

  Object.assign(session, {
    file: null, fileUrl: null, originalImage: null,
    requestId: null, correlationId: null, idempotencyKey: null,
    taskOperation: null, taskMode: null, lastOpenAttempt: null,
    labelMap: null, groups: [], editingGroupId: null, draftLayerId: null,
    groupWriteInFlight: false, layerSeq: 0,
    reusingImage: false,
  });

  setHasImage(false);
  hideTaskPreview();
  zoomCtl?.resetBoth();
  $("comparebox").hidden = true;
  $("compareToggle").setAttribute("aria-pressed", "false");
  $("compareSlider").value = "50";
  $("comparebox").style.setProperty("--split", "50%");
  setReadyFace("edit");
  $("drop").hidden = false;
  $("reuseNote").hidden = true;
  clearFile();
  resetSelectionForm();
  renderGroups();
  renderTaskList();
  setFieldError($("jobError"), null);
  machine.reset();
  updateReadout();
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

async function handleExport() {
  const button = $("exportBtn");
  button.classList.add("is-busy");
  button.disabled = true;
  try {
    // Rendered fresh at full resolution — never an upscale of the preview.
    const blob = await compositor.toBlob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const base = (session.file?.name || "image").replace(/\.[^.]+$/, "");
    const layer = compositor.getLayer(controls.activeId);
    link.href = url;
    link.download = `${base}-${slug(layer?.label) || "edit"}.png`;
    document.body.append(link);
    link.click();
    link.remove();
    // Give the download a tick to start before the URL disappears.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast(t("edit.pngSaved"));
  } catch (err) {
    toast(err?.message || t("error.exportFailed"));
  } finally {
    button.classList.remove("is-busy");
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * Readout strip
 * ------------------------------------------------------------------ *
 * Removed from the UI entirely (req 1: request/correlation ids, raw
 * backend state strings, the backend hostname, pixel dimensions — none of
 * it means anything to the person painting a wall). Kept as a no-op rather
 * than deleting its ~14 call sites throughout this file: every one of them
 * is a natural "something changed, refresh the chrome" checkpoint, and if a
 * debug view is ever wanted again, this is exactly where it plugs back in.
 */
function updateReadout() {}

/* ------------------------------------------------------------------ *
 * Job inputs (operation + mode)
 * ------------------------------------------------------------------ */

/** The mode buttons are built from CONFIG rather than written into the
 *  markup, so the values submitted and the values offered cannot drift. */
function buildModeChoice() {
  const container = $("modeChoice");
  container.innerHTML = "";
  for (const mode of CONFIG.SEGMENT_MODES) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "mode";
    input.value = mode;
    input.checked = mode === session.mode;
    input.addEventListener("change", () => {
      session.mode = mode;
      setFieldError($("jobError"), null);
      refreshSubmitState();
    });
    label.append(input, document.createTextNode(modeLabel(mode)));
    container.append(label);
  }
}

/** Falls back to a capitalized raw value for a mode that has no translation
 *  entry yet, rather than showing the dotted key (which t() would return). */
function modeLabel(mode) {
  const key = `jobForm.mode.${mode}`;
  const label = t(key);
  return label === key ? mode.charAt(0).toUpperCase() + mode.slice(1) : label;
}

/** Push session values back into the controls — used when code, not the user,
 *  changes the job (the "try the other mode" recovery, for instance). */
function syncJobInputs() {
  for (const input of document.querySelectorAll('input[name="operation"]')) {
    input.checked = input.value === session.operation;
  }
  for (const input of document.querySelectorAll('input[name="mode"]')) {
    input.checked = input.value === session.mode;
  }
  $("modeField").hidden = session.operation !== "Segment";
  $("submitBtn").querySelector(".btn__label").textContent =
    session.operation === "Regions" ? "Split into regions" : "Find the wall";
  refreshSubmitState();
}

/* ------------------------------------------------------------------ *
 * Listeners
 * ------------------------------------------------------------------ */

function wireDropzone() {
  const drop = $("drop");
  const input = $("file");

  drop.addEventListener("click", (event) => {
    if (event.target.closest("#clearFile")) return;
    input.click();
  });
  drop.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) acceptFile(file);
  });

  $("clearFile").addEventListener("click", (event) => {
    event.stopPropagation();
    clearFile();
  });

  for (const type of ["dragenter", "dragover"]) {
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add("is-over");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.remove("is-over");
    });
  }
  drop.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) acceptFile(file);
  });

  // Dropping anywhere else on the page shouldn't navigate away from the app.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
}

function wireJobForm() {
  $("jobForm").addEventListener("submit", handleSubmit);

  for (const input of document.querySelectorAll('input[name="operation"]')) {
    input.addEventListener("change", () => {
      session.operation = input.value;
      setFieldError($("jobError"), null);
      syncJobInputs();
    });
  }

  $("resumeToggle").addEventListener("click", () => {
    const panel = $("resumePanel");
    const open = panel.hidden;
    panel.hidden = !open;
    $("resumeToggle").setAttribute("aria-expanded", String(open));
    if (open && !taskList.length) refreshTaskList();
    if (!open) { hideTaskPreview(); renderTaskList(); }
  });
  $("resumeRefresh").addEventListener("click", refreshTaskList);
}

function wireSelection() {
  $("groupName").addEventListener("input", () => {
    setFieldError($("groupError"), null);
    refreshSelectionUi();
  });
  $("saveGroupBtn").addEventListener("click", saveGroup);
  $("clearSelBtn").addEventListener("click", resetSelectionForm);
  $("useSelectionBtn").addEventListener("click", () => {
    const layer = useSelection();
    if (layer) toast(t("select.readyToEdit", { label: `“${layer.label}”` }));
  });
  $("cancelGroupEdit").addEventListener("click", resetSelectionForm);
  $("toEditBtn").addEventListener("click", () => {
    setReadyFace("edit");
    controls.refresh();
    updateReadout();
  });
}

function wireBrush() {
  const modeInputs = document.querySelectorAll('input[name="brushMode"]');
  for (const input of modeInputs) {
    input.addEventListener("change", () => {
      if (input.checked) brush.setMode(input.value);
    });
  }

  const sizeInput = $("brushSize");
  const sizeReadout = $("brushSizeReadout");
  sizeInput.addEventListener("input", () => {
    brush.setSize(sizeInput.value);
    sizeReadout.textContent = `${sizeInput.value}px`;
  });

  $("brushMagnifierToggle").addEventListener("change", (event) => {
    brush.setMagnifierEnabled(event.target.checked);
  });
  brush.setMagnifierEnabled($("brushMagnifierToggle").checked);

  // The Mask tab's own draw surface only accepts pointer events while it's
  // the active tab (see body[data-edittab] in styles.css) — this keeps the
  // brush tool's own on/off flag (cursor ring, magnifier) in step with that,
  // without brush.js needing to know anything about tabs at all.
  // The bottom sheet auto-expands when a tab is picked (see js/edittabs.js),
  // which is right for Colour/Adjust but wrong for Mask: the whole point is
  // to then touch the photo, and an expanded sheet can cover it entirely on
  // a phone. Collapse it the instant a stroke starts. No-op on desktop,
  // where data-sheetopen has no visual effect.
  $("maskDrawSurface").addEventListener("pointerdown", () => {
    document.querySelector(".editcard")?.setAttribute("data-sheetopen", "false");
  }, { capture: true });

  const applyTabState = () => brush.setActive(document.body.dataset.edittab === "mask");
  applyTabState();
  new MutationObserver(applyTabState).observe(document.body, { attributes: true, attributeFilter: ["data-edittab"] });
}

function wireHistory() {
  $("undoBtn").addEventListener("click", () => controls.undo());
  $("redoBtn").addEventListener("click", () => controls.redo());

  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key !== "z" && event.key !== "Z" && event.key !== "y" && event.key !== "Y") return;
    // Only while the edit panel is actually the thing on screen — this
    // shortcut has no business firing over the job form, an email field, etc.
    if (document.body.dataset.state !== "ready" || document.body.dataset.ready !== "edit") return;
    const target = event.target;
    const textInputTypes = new Set(["text", "email", "password", "search", "tel", "url", "number"]);
    const typing = target instanceof HTMLElement
      && (target.tagName === "TEXTAREA"
        || target.isContentEditable
        || (target.tagName === "INPUT" && textInputTypes.has(target.type)));
    if (typing) return;

    if ((event.key === "z" || event.key === "Z") && event.shiftKey) {
      event.preventDefault();
      controls.redo();
    } else if (event.key === "z" || event.key === "Z") {
      event.preventDefault();
      controls.undo();
    } else if (event.key === "y" || event.key === "Y") {
      event.preventDefault();
      controls.redo();
    }
  });
}

function wireCompare() {
  const box = $("comparebox");
  const toggle = $("compareToggle");
  const slider = $("compareSlider");

  toggle.addEventListener("click", () => {
    const showing = box.hidden; // about to become visible
    box.hidden = !showing;
    toggle.setAttribute("aria-pressed", String(showing));
    if (showing) compositor.render(); // make sure #beforeCanvas has a frame the moment it appears
  });

  // One custom property drives the clip on #beforeCanvas plus the line and
  // grip markers — see .comparebox in styles.css. Nothing here needs to know
  // about any of those three elements individually.
  slider.addEventListener("input", () => {
    box.style.setProperty("--split", `${slider.value}%`);
  });
}

/**
 * A minimal zoom: CSS transform on `target`, nothing else touched. No pan/
 * scroll machinery — `.well` clips overflow (styles.css), and each wheel
 * tick re-centers the transform-origin on the current cursor position
 * before scaling further, so zooming in repeatedly naturally steers toward
 * wherever the pointer is, without needing real click-drag panning (req 7).
 *
 * Deliberately not resolution-aware: this magnifies the existing preview
 * pixels rather than re-compositing at a higher scale. That's the right
 * trade for "let me look closer", and keeps this independent of the render
 * pipeline entirely — it would work identically on any element.
 */
function createZoomController(target, { min = 1, max = 6 } = {}) {
  let scale = 1;

  function apply() {
    target.style.transform = scale === 1 ? "" : `scale(${scale})`;
  }

  return {
    get scale() { return scale; },
    reset() {
      scale = 1;
      target.style.transformOrigin = "50% 50%";
      apply();
    },
    /**
     * @param {number} factor multiplies the current scale (>1 in, <1 out)
     * @param {number} [originXPercent] where to zoom toward, 0–100
     * @param {number} [originYPercent]
     * @returns {boolean} whether the scale actually changed (false at min/max)
     */
    zoomAt(factor, originXPercent = 50, originYPercent = 50) {
      const next = Math.min(max, Math.max(min, scale * factor));
      if (next === scale) return false;
      scale = next;
      target.style.transformOrigin = `${originXPercent}% ${originYPercent}%`;
      apply();
      return true;
    },
  };
}

function wireZoom() {
  const well = $("well");
  const editZoom = createZoomController($("canvasZoomTarget"));
  const selectZoom = createZoomController($("pickerbox"));

  function isSelectFace() {
    return document.body.dataset.ready === "select";
  }
  function activeZoom() { return isSelectFace() ? selectZoom : editZoom; }
  function activeTarget() { return isSelectFace() ? $("pickerbox") : $("canvasZoomTarget"); }

  function updateReadoutLevel() {
    $("zoomLevel").textContent = `${Math.round(activeZoom().scale * 100)}%`;
  }

  well.addEventListener("wheel", (event) => {
    if (!machine.is(STATE.READY)) return;
    event.preventDefault();
    const target = activeTarget();
    const rect = target.getBoundingClientRect();
    const px = rect.width ? ((event.clientX - rect.left) / rect.width) * 100 : 50;
    const py = rect.height ? ((event.clientY - rect.top) / rect.height) * 100 : 50;
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    if (activeZoom().zoomAt(factor, px, py)) updateReadoutLevel();
  }, { passive: false });

  $("zoomIn").addEventListener("click", () => {
    if (activeZoom().zoomAt(1.25)) updateReadoutLevel();
  });
  $("zoomOut").addEventListener("click", () => {
    if (activeZoom().zoomAt(1 / 1.25)) updateReadoutLevel();
  });
  $("zoomLevel").addEventListener("click", () => {
    activeZoom().reset();
    updateReadoutLevel();
  });

  return {
    resetBoth() {
      editZoom.reset();
      selectZoom.reset();
      updateReadoutLevel();
    },
  };
}

function wire() {
  wireDropzone();
  wireJobForm();
  wireSelection();
  wireCompare();
  wireAuth();
  wireHistory();
  wireBrush();
  zoomCtl = wireZoom();

  $("cancelPoll").addEventListener("click", () => {
    stopTracking();
    showError({
      title: t("error.stoppedWaiting.title"),
      message: t("error.stoppedWaiting.message"),
      primary: { label: t("error.notReady.checkAgain"), action: () => { machine.to(STATE.TRACKING); startTracking(); } },
      secondary: { label: t("error.startOver"), action: resetAll },
    });
  });

  $("exportBtn").addEventListener("click", handleExport);
  $("newImageBtn").addEventListener("click", resetAll);

  $("addRegionBtn").addEventListener("click", () => {
    if (isRegionsTask()) {
      // No backend call: the same label map supports any number of surfaces.
      resetSelectionForm();
      setReadyFace("select");
      updateReadout();
      return;
    }
    // Segment: the only other thing to ask for is the other mode, and that
    // is a new task.
    const other = CONFIG.SEGMENT_MODES.find((m) => m !== session.taskMode);
    if (other) session.mode = other;
    session.operation = "Segment";
    syncJobInputs();
    backToForm({ reuseImage: true });
  });

  machine.subscribe(() => {
    refreshSubmitState();
    updateReadout();
  });

  // Re-render on resize only matters for CSS fit, not pixels, so nothing to
  // recompute — but a devicePixelRatio change (moving to another monitor)
  // does deserve a fresh preview.
  let lastDpr = window.devicePixelRatio;
  window.addEventListener("resize", () => {
    if (window.devicePixelRatio !== lastDpr) {
      lastDpr = window.devicePixelRatio;
      if (machine.is(STATE.READY)) {
        controls.schedule();
        picker.redraw();
      }
    }
  });

  // Memory-only session: say so before it disappears. An unsaved selection
  // counts as work — the region ids only exist in this tab until saved.
  window.addEventListener("beforeunload", (event) => {
    const unsavedSelection = machine.is(STATE.READY)
      && document.body.dataset.ready === "select"
      && picker.size > 0;
    const hasWork = machine.is(STATE.TRACKING)
      || unsavedSelection
      || (machine.is(STATE.READY) && compositor.layers.some((l) => !isUnedited(l.edits)));
    if (!hasWork) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

/**
 * Handles the Google OAuth callback and decides whether the login screen or
 * the app itself is the first thing shown.
 *
 * This app does not implement silent refresh (§1.1's "decide explicitly"):
 * there is no background exchange of a refresh token before the access
 * token expires. A token that expires mid-session surfaces as a normal 401,
 * which handleFailure's "auth" case already routes to the login screen with
 * the interrupted action queued in auth.resumeAction — so re-authenticating
 * resumes the session rather than losing it, without this app needing to
 * track a refresh token's own lifetime separately. If the backend later
 * hands back a refresh token and silent refresh becomes worth the added
 * state, that decision belongs here, not scattered across every call site
 * that currently catches "auth".
 *
 * The callback contract assumed below (`access_token` for a completed
 * sign-in, `two_factor_token` for one still needing a code) is this app's
 * one guess about how the backend's OAuth redirect delivers a token to
 * client-side JS, since there was no running backend to observe it against.
 * Confirm it against the real redirect and adjust just this function if the
 * parameter names differ.
 */
function bootAuth() {
  const params = new URLSearchParams(window.location.search);
  const oauthToken = params.get("access_token");
  const oauthTwoFactorToken = params.get("two_factor_token");

  if (oauthToken || oauthTwoFactorToken) {
    // Leaves the address bar clean so a real credential doesn't sit in
    // history or get copy-pasted around — same instinct as the old dev
    // `?token=` seeding, applied to a real callback instead of a paste.
    params.delete("access_token");
    params.delete("two_factor_token");
    const query = params.toString();
    history.replaceState({}, "", window.location.pathname + (query ? `?${query}` : ""));
  }

  if (oauthToken) {
    completeAuth(oauthToken);
    return;
  }
  if (oauthTwoFactorToken) {
    auth.twoFactorToken = oauthTwoFactorToken;
    showAuth("twofactor");
    return;
  }

  if (isAuthed()) {
    toggleAuthed(true);
  } else {
    showAuth("login");
  }
}

function boot() {
  buildModeChoice();
  syncJobInputs();
  wire();
  refreshSelectionUi();
  updateReadout();
  bootAuth();
}

boot();
