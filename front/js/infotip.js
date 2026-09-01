// infotip.js — click/tap toggling for .infotip bubbles.
//
// Hover and keyboard focus already show a bubble with plain CSS (see
// .infotip:hover / :focus-visible in styles.css) — nothing to do for that.
// This file only adds the other half the task asked for: a click on the
// icon toggles it too (needed on touch, where there's no hover), a second
// click or a click elsewhere closes it, and so does Escape. Standalone like
// theme.js/edittabs.js/sidebar.js — no state-machine knowledge here either.

function closeAll(except) {
  for (const open of document.querySelectorAll(".infotip.is-open")) {
    if (open !== except) open.classList.remove("is-open");
  }
}

document.addEventListener("click", (event) => {
  const icon = event.target.closest(".infotip__icon");
  if (icon) {
    const wrap = icon.closest(".infotip");
    const willOpen = !wrap.classList.contains("is-open");
    closeAll();
    wrap.classList.toggle("is-open", willOpen);
    event.preventDefault();
    return;
  }
  if (!event.target.closest(".infotip__bubble")) closeAll();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeAll();
});
