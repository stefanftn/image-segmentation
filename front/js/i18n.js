// i18n.js — string lookup + applying translations to static markup.
//
// How this works, Android-strings-style:
//   - Every language lives in its own file under js/strings/ (see en.js for
//     the reference set and its own comment on adding a new one).
//   - Static text in index.html is never typed directly into the HTML —
//     it's a data-i18n="some.key" (textContent) or
//     data-i18n-attr="title:some.key,aria-label:other.key" (attributes),
//     and applyStatic() below fills those in once, on load.
//   - Text built at runtime (toasts, chip labels, counts...) calls
//     t("some.key", { vars }) directly from app.js / controls.js / regions.js
//     instead of writing English literals inline.
//
// This file is standalone like theme.js/edittabs.js — it doesn't read or
// write body[data-state]/[data-ready], it only reads STRINGS and touches
// [data-i18n]/[data-i18n-attr] elements and whatever calls t() later.

import { STRINGS as EN } from "./strings/en.js";

// Add a language by importing it here and adding it to LOCALES — e.g.
//   import { STRINGS as SR } from "./strings/sr.js";
//   const LOCALES = { en: EN, sr: SR };
// and change DEFAULT_LOCALE (or read it from <html lang>, a query string,
// a saved preference — whatever fits later; kept simple on purpose for now).
const LOCALES = { en: EN };
const DEFAULT_LOCALE = "en";

let dict = LOCALES[DEFAULT_LOCALE] || EN;

function lookup(key) {
  return key.split(".").reduce((node, part) => {
    return node && Object.prototype.hasOwnProperty.call(node, part) ? node[part] : undefined;
  }, dict);
}

/**
 * Look up a string by dotted key ("edit.download") and optionally fill in
 * {{placeholder}} tokens. Falls back to the key itself (and a console
 * warning) if nothing is found, so a missing translation is loud in
 * development rather than silently blank in the UI.
 */
export function t(key, vars) {
  const value = lookup(key);
  if (typeof value !== "string") {
    console.warn(`[i18n] missing string for key "${key}"`);
    return key;
  }
  if (!vars) return value;
  return value.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  );
}

/** Fill in every [data-i18n] / [data-i18n-attr] element under `root`. */
export function applyStaticI18n(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.getAttribute("data-i18n"));
  }
  for (const el of root.querySelectorAll("[data-i18n-attr]")) {
    // "attr:key.path,attr2:other.key" — lets one element translate several
    // attributes (e.g. a title and an aria-label) without extra markup.
    const spec = el.getAttribute("data-i18n-attr") || "";
    for (const pair of spec.split(",")) {
      const [attr, key] = pair.split(":").map((part) => part.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
}

applyStaticI18n();
