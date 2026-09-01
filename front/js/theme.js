// theme.js — light/dark toggle.
//
// Deliberately standalone: reads/writes <html data-theme> and localStorage,
// wires the two #themeToggle(Auth) buttons, and nothing else. It never
// touches body[data-state]/[data-ready] or body.authed, so it works the same
// whether the person is signed in, mid-upload, or looking at an error — a
// display preference isn't a step in the task flow.
//
// Default: "dark" for anyone without a saved preference (see STORAGE_KEY) —
// that's the primary look the app now ships with. The <html> tag's own
// data-theme="light" attribute is the no-JS fallback, so the page still
// renders sensibly if this script fails to load.

const STORAGE_KEY = "mw-theme";
const root = document.documentElement;

function applyTheme(theme) {
  root.setAttribute("data-theme", theme);
  const isDark = theme === "dark";
  for (const btn of document.querySelectorAll("#themeToggle, #themeToggleAuth, #themeToggleSidebar")) {
    btn.setAttribute("aria-pressed", String(isDark));
    btn.title = isDark ? "Switch to light theme" : "Switch to dark theme";
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

applyTheme(initialTheme());

document.addEventListener("DOMContentLoaded", () => {
  for (const btn of document.querySelectorAll("#themeToggle, #themeToggleAuth, #themeToggleSidebar")) {
    btn.addEventListener("click", () => {
      const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch (err) {
        // ignore — theme still applies for this page view
      }
    });
  }
});
