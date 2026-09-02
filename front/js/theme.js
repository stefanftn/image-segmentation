// theme.js — light/dark theme state.
//
// Deliberately standalone: reads/writes <html data-theme> and localStorage,
// and nothing else. It never touches body[data-state]/[data-ready] or
// body.authed, so it works the same whether the person is signed in,
// mid-upload, or looking at an error — a display preference isn't a step in
// the task flow.
//
// The actual UI lives in the Settings dialog (see js/settings.js) as a
// Light/Dark radio pair — this file just keeps that pair, <html data-theme>,
// and localStorage all in sync with each other, however the change
// happened (a click on a radio, or setTheme() called from elsewhere).
//
// Default: "dark" for anyone without a saved preference (see STORAGE_KEY) —
// that's the primary look the app now ships with. The <html> tag's own
// data-theme="light" attribute is the no-JS fallback, so the page still
// renders sensibly if this script fails to load.

const STORAGE_KEY = "mw-theme";
const root = document.documentElement;

function applyTheme(theme) {
  root.setAttribute("data-theme", theme);
  for (const radio of document.querySelectorAll('input[name="settingsTheme"]')) {
    radio.checked = radio.value === theme;
  }
}

function initialTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch (err) {
    // localStorage unavailable (private mode, etc.) — fall through to default
  }
  return "dark";
}

/** Current theme, "light" or "dark". */
export function getTheme() {
  return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/** Sets the theme and persists it — the one place both of those happen
 *  together, so nothing can update <html> without also saving the choice
 *  (or vice versa). */
export function setTheme(theme) {
  applyTheme(theme === "dark" ? "dark" : "light");
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch (err) {
    // ignore — theme still applies for this page view
  }
}

applyTheme(initialTheme());

// Delegated on document rather than queried once at load, so this keeps
// working even for radios that don't exist yet at this point in module
// evaluation order (none currently, but this is the same reasoning
// infotip.js already uses for its own delegated listeners).
document.addEventListener("change", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.name === "settingsTheme") {
    setTheme(event.target.value);
  }
});
