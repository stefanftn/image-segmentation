/**
 * api.js — every network call the client makes, and nothing else.
 *
 * All against the backend (backend spec §13) — one ASP.NET Core process, not
 * a gateway routing to separate services:
 *   POST   /api/auth/register               → { token, expiresAtUtc } | { requiresTwoFactor, twoFactorToken }
 *   POST   /api/auth/login                  → { token, expiresAtUtc } | { requiresTwoFactor, twoFactorToken }
 *   POST   /api/auth/2fa/verify             → { token, expiresAtUtc }
 *   GET    /api/auth/google/login           → browser redirect, not a fetch — see googleLoginUrl()
 *   POST   /api/images/process              → { requestId, correlationId, state }
 *   GET    /api/images/{id}/status          → { operation, mode, state, … }
 *   GET    /api/images/{id}/result          → bytes: a mask, or a label map
 *   GET    /api/images/{id}/original        → bytes: the originally uploaded photo
 *   GET    /api/images                      → the caller's own recent tasks
 *   DELETE /api/images/{id}                 → remove a task and its data
 *   GET    /api/images/{id}/groups          → saved region selections
 *   POST   /api/images/{id}/groups          → create one
 *   PUT    /api/images/{id}/groups/{gid}    → replace one
 *   DELETE /api/images/{id}/groups/{gid}    → remove one
 *
 * The exact shapes of the /api/auth/* responses are this file's one
 * assumption rather than an observed fact — there was no auth backend to
 * inspect before this migration. Confirm them against the real
 * ApplicationUser / Identity setup and adjust login()/register()/
 * verifyTwoFactor() together if they differ; every caller only ever sees the
 * normalized `{ token, expiresAtUtc }` / `{ requiresTwoFactor, twoFactorToken }`
 * shape below, so a mismatch is a one-file fix.
 *
 * Callers never read `response.status`. They catch an ApiError and branch on
 * `err.kind`, so the mapping from HTTP to meaning lives in exactly one file.
 *
 * Auth scoping is deliberately not uniform, and this file does nothing to
 * smooth that over: /status, /result, and /original are readable by anyone
 * holding a task id, while /api/images and every /groups route are scoped to
 * the caller's JWT identity and answer a mismatch with 404 rather than 403 —
 * so a caller cannot learn that someone else's task exists. That means a 404
 * from a groups call is genuinely ambiguous between "no such task" and "not
 * yours", and the UI should not claim to know which.
 */

import { CONFIG, apiUrl } from "./config.js";

/* ------------------------------------------------------------------ *
 * Auth token
 * ------------------------------------------------------------------ *
 * Held in sessionStorage so a tab reload keeps the session but closing
 * the tab ends it. The token is now a real credential returned by
 * login()/register()/verifyTwoFactor() or the Google OAuth callback —
 * there is no dev-mode value that fills in when nothing has been set.
 */
const TOKEN_KEY = "maskwork.token";

export function getAuthToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return ""; // private mode, storage disabled
  }
}

export function setAuthToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* non-fatal */
  }
}

function authHeaders(extra = {}) {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}`, ...extra } : { ...extra };
}

/* ------------------------------------------------------------------ *
 * Auth — login, register, 2FA, Google OAuth (§1 of the migration notes)
 * ------------------------------------------------------------------ *
 * These calls happen before a token exists, so they never go through
 * authHeaders()/requestJson() — a request with no Authorization header is
 * exactly what's wanted here, not an oversight. They use request()/toApiError()
 * further down this file; function declarations are hoisted, so the physical
 * order here doesn't affect anything at runtime.
 */

/** Shared plumbing for the three unauthenticated auth POSTs below. Same
 *  error vocabulary as requestJson(), duplicated rather than shared because
 *  requestJson() always calls authHeaders(), which would attach whatever
 *  stale token is sitting in sessionStorage to a login/register/2FA call —
 *  harmless for the backend but confusing to reason about. */
async function postAuthJson(path, body) {
  const response = await request(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await toApiError(response);
  return response.json().catch(() => ({}));
}

/**
 * Normalizes whatever the backend's login/register endpoints return into one
 * shape the UI can branch on without knowing the wire format:
 *   - `{ done: true, token, expiresAtUtc }` — session established
 *   - `{ done: false, twoFactorToken }` — a 6-digit TOTP code is needed next,
 *     via verifyTwoFactor()
 * Adjust the field names read below (`requiresTwoFactor`, `twoFactorToken`,
 * `token`, `expiresAtUtc`) to match the real ApplicationUser/Identity
 * response if they differ — this is the one place that mapping lives.
 */
function normalizeAuthResponse(body) {
  if (body?.requiresTwoFactor) {
    return { done: false, twoFactorToken: body.twoFactorToken ?? null };
  }
  return { done: true, token: body?.token ?? null, expiresAtUtc: body?.expiresAtUtc ?? null };
}

/** @param {{email: string, password: string}} credentials */
export async function login({ email, password }) {
  const body = await postAuthJson("/api/auth/login", { email, password });
  return normalizeAuthResponse(body);
}

/** @param {{email: string, password: string}} fields — confirm the exact set
 *  ApplicationUser actually requires (a confirm-password field, a display
 *  name, etc.) against the real Identity setup rather than assuming this is
 *  the whole shape. */
export async function register({ email, password }) {
  const body = await postAuthJson("/api/auth/register", { email, password });
  return normalizeAuthResponse(body);
}

/** @param {{twoFactorToken: string, code: string}} fields */
export async function verifyTwoFactor({ twoFactorToken, code }) {
  const body = await postAuthJson("/api/auth/2fa/verify", { twoFactorToken, code });
  return { token: body?.token ?? null, expiresAtUtc: body?.expiresAtUtc ?? null };
}

/**
 * URL for the "Continue with Google" button — a plain navigation
 * (`window.location.href = googleLoginUrl()`), not a fetch. The backend owns
 * the entire OAuth dance and redirects the browser back to `returnUrl` once
 * it has established a session, so there is nothing here to await.
 *
 * @param {string} returnUrl where the backend should send the browser back
 *   to once sign-in completes — see the boot()-time handling in app.js for
 *   what that redirect target is expected to carry.
 */
export function googleLoginUrl(returnUrl) {
  return apiUrl(`/api/auth/google/login?returnUrl=${encodeURIComponent(returnUrl)}`);
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * kind is the vocabulary the UI branches on:
 *   "validation" | "auth" | "rate_limit" | "not_ready" | "not_found"
 *   | "server" | "network" | "timeout" | "aborted" | "unknown"
 *
 * "not_ready" is the odd one out: it means the request was well-formed and
 * authorised, and the only thing wrong with it is when it was made. It is the
 * one kind that a plain retry can be expected to resolve on its own.
 */
export class ApiError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = extra.status ?? null;
    this.retryAfterSeconds = extra.retryAfterSeconds ?? null;
    this.correlationId = extra.correlationId ?? null;
    this.detail = extra.detail ?? null;
  }
}

function kindForStatus(status) {
  if (status === 400 || status === 413 || status === 415 || status === 422) return "validation";
  if (status === 401 || status === 403) return "auth";
  if (status === 404 || status === 410) return "not_found";
  // 409 from /result: the task exists but has not reached Completed yet.
  if (status === 409) return "not_ready";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "unknown";
}

/** Best-effort read of a server-supplied message. Accepts RFC 7807
 *  problem+json, a bare `{ message }`, or plain text. Never throws. */
async function readErrorBody(response) {
  try {
    const type = response.headers.get("Content-Type") || "";
    if (type.includes("json")) {
      const body = await response.json();
      const message =
        body.detail || body.title || body.message || body.error || null;
      return { message, correlationId: body.correlationId ?? null };
    }
    const text = (await response.text()).trim();
    return { message: text ? text.slice(0, 300) : null, correlationId: null };
  } catch {
    return { message: null, correlationId: null };
  }
}

function parseRetryAfter(response) {
  const raw = response.headers.get("Retry-After");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
  // HTTP-date form
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.round((when - Date.now()) / 1000));
}

async function toApiError(response) {
  const { message, correlationId } = await readErrorBody(response);
  const kind = kindForStatus(response.status);
  return new ApiError(kind, message || `Request failed (${response.status}).`, {
    status: response.status,
    retryAfterSeconds: parseRetryAfter(response),
    correlationId: correlationId || response.headers.get("X-Correlation-Id"),
    detail: message,
  });
}

/** Wrap fetch so a DNS failure, an offline radio and a CORS rejection all
 *  arrive as one recognisable thing instead of a bare TypeError. */
async function request(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new ApiError("aborted", "Request cancelled.");
    }
    throw new ApiError(
      "network",
      "Could not reach the server.",
      { detail: err?.message ?? String(err) },
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** UUID v4, with a fallback for browsers/contexts without crypto.randomUUID
 *  (notably any non-secure origin). */
export function newIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  (globalThis.crypto || { getRandomValues: (b) => b.forEach((_, i) => (b[i] = Math.floor(Math.random() * 256))) })
    .getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ------------------------------------------------------------------ *
 * 4.1 Submit
 * ------------------------------------------------------------------ */

/**
 * @param {File} file
 * @param {object} job
 * @param {"Segment"|"Regions"} job.operation  which model to run
 * @param {"interior"|"exterior"} [job.mode]   only read for Segment; the
 *        server ignores it on a Regions submission, so it is simply omitted
 *        rather than sent as null.
 * @param {object} opts
 * @param {string} opts.idempotencyKey  one per user-initiated submit; reused
 *        verbatim across this function's internal network retries so a flaky
 *        connection or a double-click can never create two tasks (§2.1). The
 *        dedup window is now scoped to operation+mode rather than to a prompt,
 *        which is why a mode change has to be a fresh key: same photo, same
 *        key, different mode would be answered with the first task's result.
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{requestId: string, correlationId: string, state: string|null}>}
 */
export async function submitTask(file, { operation, mode } = {}, { idempotencyKey, signal } = {}) {
  const key = idempotencyKey || newIdempotencyKey();
  const url = apiUrl("/api/images/process");

  let attempt = 0;
  for (;;) {
    const form = new FormData();
    form.append("image", file, file.name);
    form.append("operation", operation);
    if (operation === "Segment" && mode) form.append("mode", mode);

    let response;
    try {
      response = await request(url, {
        method: "POST",
        headers: authHeaders({ "Idempotency-Key": key }),
        // Content-Type is deliberately unset: the browser must add the
        // multipart boundary itself.
        body: form,
        signal,
      });
    } catch (err) {
      // Only transport failures are retried, and only with the same key.
      const retryable = err.kind === "network" && attempt < CONFIG.SUBMIT_NETWORK_RETRIES;
      if (!retryable) throw err;
      attempt += 1;
      await sleep(400 * attempt);
      continue;
    }

    if (response.status === 202 || response.ok) {
      const body = await response.json().catch(() => ({}));
      if (!body.requestId) {
        throw new ApiError("server", "The server accepted the job but did not return an id.");
      }
      return {
        requestId: body.requestId,
        correlationId: body.correlationId ?? response.headers.get("X-Correlation-Id") ?? null,
        state: body.state ?? null,
      };
    }

    // 5xx on submit: worth one transport-style retry with the same key.
    if (response.status >= 500 && attempt < CONFIG.SUBMIT_NETWORK_RETRIES) {
      attempt += 1;
      await sleep(400 * attempt);
      continue;
    }

    throw await toApiError(response);
  }
}

/* ------------------------------------------------------------------ *
 * 4.2 Status
 * ------------------------------------------------------------------ */

/** Backend task states (§1.1). */
export const TASK_STATES = Object.freeze({
  PENDING: "Pending",
  PREPROCESSING: "Preprocessing",
  PROCESSING: "Processing",
  COMPLETED: "Completed",
  FAILED: "Failed",
});

export const TERMINAL_STATES = new Set([TASK_STATES.COMPLETED, TASK_STATES.FAILED]);

/**
 * One status read. Callers schedule the next one; this function never loops,
 * so a slow response can't overlap with the following request.
 *
 * `operation` is the field that decides what the bytes from /result mean —
 * a mask to composite, or a label map to select regions in — so it is read
 * from the status response rather than remembered from the submit call. On a
 * resumed session there was no submit call in this tab to remember.
 *
 * @returns {Promise<{operation: string|null, mode: string|null, state: string,
 *   isTerminal: boolean, updatedAtUtc: string|null, errorMessage: string|null,
 *   resultUrl: string|null}>}
 */
export async function pollStatus(requestId, { signal } = {}) {
  const response = await request(
    apiUrl(`/api/images/${encodeURIComponent(requestId)}/status`),
    { method: "GET", headers: authHeaders({ Accept: "application/json" }), signal, cache: "no-store" },
  );

  if (!response.ok) throw await toApiError(response);

  const body = await response.json().catch(() => null);
  if (!body?.state) {
    throw new ApiError("server", "The status response was not in the expected shape.");
  }
  return {
    operation: body.operation ?? null,
    mode: body.mode ?? null,
    state: body.state,
    // Trusted when present, derived otherwise: an older backend that predates
    // the field would otherwise look like a task that never terminates.
    isTerminal: body.isTerminal ?? TERMINAL_STATES.has(body.state),
    updatedAtUtc: body.updatedAtUtc ?? null,
    errorMessage: body.errorMessage ?? null,
    resultUrl: body.resultUrl ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * 4.3 Result — a mask, or a label map
 * ------------------------------------------------------------------ */

/**
 * Fetch the result bytes as a Blob.
 *
 * Named `fetchResult`, not `fetchMask`: the transport is unchanged, but the
 * bytes now mean one of two different things depending on the task's
 * `operation`. A Segment task returns a wall mask. A Regions task returns a
 * grayscale label map, where a pixel's value is the id of the visual region it
 * belongs to — which is emphatically not a mask, and feeding it to
 * normalizeMask() would produce a "mask" of every region with an id above the
 * threshold. This function stays operation-agnostic byte transport; deciding
 * what to do with the bytes is the caller's job.
 *
 * Two backend shapes, one client path (§4.3):
 *   • 302 to a presigned MinIO URL — fetch follows it transparently, so the
 *     redirect never surfaces here;
 *   • direct byte stream for FTP-backed tasks.
 * Either way this resolves to image bytes.
 *
 * Why fetch rather than pointing an <img> straight at the endpoint: /result
 * requires an Authorization header and an <img src> cannot carry one. Going
 * through fetch also means the bytes become a same-origin blob: URL, which
 * removes canvas tainting as a failure mode entirely.
 *
 * CORS is still a hard backend dependency, because the fetch itself is
 * cross-origin: the backend's /result response *and* the presigned MinIO URL
 * (bucket CORS policy) must both allow this origin — and the presigned URL
 * must allow the Range/Authorization preflight if it triggers one. Without
 * that, this call fails at the browser before any pixel work starts. That is
 * a backend configuration item (§9.1), not something to paper over here.
 *
 * Retried harder than a poll: reaching this function means the task already
 * reported Completed, so a failure is transport trouble, not a failed job.
 */
export async function fetchResult(requestId, { signal } = {}) {
  const url = apiUrl(`/api/images/${encodeURIComponent(requestId)}/result`);
  let lastError = null;

  for (let attempt = 0; attempt <= CONFIG.MASK_FETCH_RETRIES; attempt += 1) {
    if (attempt > 0) {
      await sleep(CONFIG.MASK_FETCH_BACKOFF_MS * 2 ** (attempt - 1));
    }
    try {
      const response = await request(url, {
        method: "GET",
        headers: authHeaders({ Accept: "image/*" }),
        redirect: "follow", // the 302 to MinIO is handled here, silently
        signal,
        cache: "no-store",
      });

      if (!response.ok) {
        const err = await toApiError(response);
        // Auth and validation failures will not fix themselves on retry.
        if (err.kind === "auth" || err.kind === "validation") throw err;
        // "not_ready" (409) is the case this backoff exists for: status said
        // Completed a moment ago and the object is not readable yet. It goes
        // through the same escalating waits as a transport failure rather
        // than being hammered on a tight loop or given up on immediately.
        lastError = err;
        continue;
      }

      const blob = await response.blob();
      if (blob.size === 0) {
        lastError = new ApiError("server", "The result came back empty.");
        continue;
      }
      return blob;
    } catch (err) {
      if (err instanceof ApiError && (err.kind === "auth" || err.kind === "aborted")) throw err;
      lastError = err instanceof ApiError ? err : new ApiError("network", "Could not download the result.");
    }
  }

  throw lastError ?? new ApiError("network", "Could not download the result.");
}

/**
 * Fetch the originally uploaded photo as a Blob — `GET /api/images/{id}/original`.
 *
 * Same transport as fetchResult in every respect (302-or-stream, fetch
 * rather than an <img> tag for the same Authorization/tainting reasons, same
 * CORS dependency on both the backend response and the presigned URL). The
 * differences are all in what the backend guarantees about *when* this
 * works, which is what makes it useful for resuming a session rather than
 * just re-displaying a finished one:
 *
 *   - works for any task State, not just Completed — including Failed, so a
 *     failed job can still show the photo the person tried, not a blank well
 *   - 404 only if the task itself doesn't exist at all
 *   - not owner-scoped, consistent with /status and /result — any caller
 *     holding the task id can read it
 *
 * This is what makes "Open" on a saved session a one-click action rather
 * than "load the same photo yourself first": the pixels the session was
 * built from are always available from here, independent of local state.
 */
export async function fetchOriginal(requestId, { signal } = {}) {
  const url = apiUrl(`/api/images/${encodeURIComponent(requestId)}/original`);
  let lastError = null;

  for (let attempt = 0; attempt <= CONFIG.MASK_FETCH_RETRIES; attempt += 1) {
    if (attempt > 0) {
      await sleep(CONFIG.MASK_FETCH_BACKOFF_MS * 2 ** (attempt - 1));
    }
    try {
      const response = await request(url, {
        method: "GET",
        headers: authHeaders({ Accept: "image/*" }),
        redirect: "follow",
        signal,
        cache: "no-store",
      });

      if (!response.ok) {
        const err = await toApiError(response);
        if (err.kind === "auth" || err.kind === "validation") throw err;
        lastError = err;
        continue;
      }

      const blob = await response.blob();
      if (blob.size === 0) {
        lastError = new ApiError("server", "The original photo came back empty.");
        continue;
      }
      return blob;
    } catch (err) {
      if (err instanceof ApiError && (err.kind === "auth" || err.kind === "aborted")) throw err;
      lastError = err instanceof ApiError ? err : new ApiError("network", "Could not download the original photo.");
    }
  }

  throw lastError ?? new ApiError("network", "Could not download the original photo.");
}

/* ------------------------------------------------------------------ *
 * Task list
 * ------------------------------------------------------------------ */

/** Shared plumbing for the JSON endpoints below. Same request(),
 *  authHeaders() and toApiError() as everything above — the new routes need
 *  no error vocabulary of their own. */
async function requestJson(path, { method = "GET", body = null, signal } = {}) {
  const headers = authHeaders({ Accept: "application/json" });
  if (body != null) headers["Content-Type"] = "application/json";

  const response = await request(apiUrl(path), {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
    signal,
    cache: "no-store",
  });

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

/**
 * The caller's own recent tasks, newest first, capped at 100 by the server
 * with no pagination — so this is a "recent work" list, not an archive.
 *
 * Scoped to the JWT identity that submitted them: someone else's task is a
 * 404, not a 403.
 *
 * @param {{operation?: string, state?: string}} [filter]
 * @returns {Promise<Array<{requestId, operation, mode, state, createdAtUtc, updatedAtUtc}>>}
 */
export async function listImages({ operation, state } = {}, { signal } = {}) {
  const query = new URLSearchParams();
  if (operation) query.set("operation", operation);
  if (state) query.set("state", state);
  const suffix = query.toString() ? `?${query}` : "";
  const body = await requestJson(`/api/images${suffix}`, { signal });
  return Array.isArray(body) ? body : [];
}

/**
 * Delete a task entirely — `DELETE /api/images/{id}`. New in this backend;
 * the old one had no equivalent endpoint.
 *
 * Not retried on network failure, same reasoning as the group-write verbs
 * below: a blind retry is low-risk here specifically, since delete is
 * naturally idempotent server-side (a second DELETE for an already-gone id
 * is a 404, not a second effect) — but confirm that against the real
 * endpoint rather than assuming, same as every other "should this retry"
 * call in this file.
 *
 * Resolves to null — the server answers 204 with no body.
 */
export function deleteImage(taskId, { signal } = {}) {
  return requestJson(`/api/images/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
    signal,
  });
}

/* ------------------------------------------------------------------ *
 * Mask groups — saved region selections
 * ------------------------------------------------------------------ *
 * Only meaningful for a Completed Regions task; anything else is a 400.
 *
 * None of the write verbs accept an Idempotency-Key, which makes them the one
 * place in this file where a blind retry is unsafe: submitTask can repeat a
 * request because the server will recognise the key and hand back the original
 * task, but a repeated POST here just creates a second group with the same
 * name. So these three do exactly one attempt each and let the caller decide,
 * and the caller's job is to make a second attempt impossible while the first
 * is in flight.
 */

/** @returns {Promise<Array<{id, imageTaskId, name, regionIds, createdAtUtc, updatedAtUtc}>>} */
export async function listMaskGroups(taskId, { signal } = {}) {
  const body = await requestJson(
    `/api/images/${encodeURIComponent(taskId)}/groups`,
    { signal },
  );
  return Array.isArray(body) ? body : [];
}

/** Not retried on network failure — see the note above. */
export function createMaskGroup(taskId, { name, regionIds }, { signal } = {}) {
  return requestJson(`/api/images/${encodeURIComponent(taskId)}/groups`, {
    method: "POST",
    body: { name, regionIds: [...regionIds] },
    signal,
  });
}

export function updateMaskGroup(taskId, groupId, { name, regionIds }, { signal } = {}) {
  return requestJson(
    `/api/images/${encodeURIComponent(taskId)}/groups/${encodeURIComponent(groupId)}`,
    { method: "PUT", body: { name, regionIds: [...regionIds] }, signal },
  );
}

/** Resolves to null — the server answers 204 with no body. */
export function deleteMaskGroup(taskId, groupId, { signal } = {}) {
  return requestJson(
    `/api/images/${encodeURIComponent(taskId)}/groups/${encodeURIComponent(groupId)}`,
    { method: "DELETE", signal },
  );
}
