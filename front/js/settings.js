// settings.js — opens/closes the Settings dialog from its three entry
// points (the masthead gear, the auth-screen gear, and the hamburger
// sidebar's own Settings row). Doesn't own theme or language state itself
// — see theme.js for that — this is just the dialog's open/close plumbing,
// the same standalone pattern as sidebar.js/infotip.js.

const dialog = document.getElementById("settingsDialog");
const backdrop = document.getElementById("settingsBackdrop");

if (dialog && backdrop) {
  function open() {
    dialog.hidden = false;
    backdrop.hidden = false;
  }
  function close() {
    dialog.hidden = true;
    backdrop.hidden = true;
  }

  for (const btn of document.querySelectorAll("#settingsToggle, #settingsToggleAuth, #settingsToggleSidebar")) {
    btn.addEventListener("click", () => {
      // Opened from the hamburger sidebar: close that first so the two
      // overlays never stack.
      document.getElementById("appSidebar")?.classList.remove("is-open");
      open();
    });
  }

  document.getElementById("settingsClose")?.addEventListener("click", close);
  backdrop.addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dialog.hidden) close();
  });
}
