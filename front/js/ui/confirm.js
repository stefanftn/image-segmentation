// confirm.js — a themed replacement for window.confirm(), used for the
// app's two destructive actions (deleting a saved selection, deleting a
// job). The browser's native confirm() can't be styled at all and looks
// jarringly out of place next to everything else here.
//
// confirmDialog({ title, message, confirmLabel }) returns a Promise<bool>
// — the same shape a caller would get from window.confirm(), just async
// (a real dialog can't block the way the native one does) and filled in
// per call rather than being one fixed piece of copy.
//
// Standalone like theme.js/ui/sidebar.js/ui/settings.js — reuses the exact same
// backdrop-plus-centered-panel structure settings.js already established
// (see .settingsdialog/.settingsbackdrop in styles.css), just with its own
// two elements so opening one can never stomp on the other's state.

const backdrop = document.getElementById("confirmBackdrop");
const dialog = document.getElementById("confirmDialog");
const titleEl = document.getElementById("confirmTitle");
const messageEl = document.getElementById("confirmMessage");
const okBtn = document.getElementById("confirmOk");
const cancelBtn = document.getElementById("confirmCancel");

let resolvePending = null;

function close(result) {
  dialog.hidden = true;
  backdrop.hidden = true;
  if (resolvePending) {
    const resolve = resolvePending;
    resolvePending = null;
    resolve(result);
  }
}

/** Shows the confirm dialog and resolves true/false with the person's
 *  choice. If called again while one is already open (shouldn't happen in
 *  practice — nothing here is reentrant), the earlier call resolves false
 *  rather than being left pending forever. */
export function confirmDialog({ title, message, confirmLabel } = {}) {
  return new Promise((resolve) => {
    if (resolvePending) close(false);
    resolvePending = resolve;
    titleEl.textContent = title || "Are you sure?";
    messageEl.textContent = message || "";
    if (confirmLabel) okBtn.textContent = confirmLabel;
    dialog.hidden = false;
    backdrop.hidden = false;
    okBtn.focus();
  });
}

if (dialog && backdrop) {
  okBtn.addEventListener("click", () => close(true));
  cancelBtn.addEventListener("click", () => close(false));
  backdrop.addEventListener("click", () => close(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dialog.hidden) close(false);
  });
}
