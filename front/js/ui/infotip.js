// infotip.js — click/tap toggling for .infotip bubbles, and keeping every
// bubble inside the viewport.
//
// Hover and keyboard focus already show a bubble with plain CSS (see
// .infotip:hover / :focus-visible in styles.css) — nothing to do to make
// one appear. What this file adds:
//   - a click on the icon toggles it too (needed on touch, where there's no
//     hover), a second click or a click elsewhere closes it, so does Escape
//   - a bubble that would run off the left or right edge of the viewport
//     gets nudged back in, by actually measuring it rather than guessing
//     from a screen-width media query (a bubble near the left edge of a
//     wide desktop rail overflows exactly the same way a mobile one does)
// Standalone like theme.js/ui/edittabs.js/ui/sidebar.js — no state-machine
// knowledge here either.

const MARGIN = 8; // minimum gap to keep between a bubble and the viewport edge

function closeAll(except) {
  for (const open of document.querySelectorAll(".infotip.is-open")) {
    if (open !== except) open.classList.remove("is-open");
  }
}

/** The nearest ancestor whose computed overflow-x would actually clip
 *  `el` — for this app that's always .rail (or the mobile bottom sheet,
 *  same idea), but walking up rather than hardcoding a selector means this
 *  keeps working if a bubble ever ends up somewhere else, like the sidebar. */
function clippingAncestor(el) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflowX = getComputedStyle(node).overflowX;
    if (overflowX === "hidden" || overflowX === "clip" || overflowX === "auto" || overflowX === "scroll") {
      return node;
    }
  }
  return null;
}

/** Sets `wrap`'s bubble's --infotip-shift so it lands fully inside whichever
 *  box would otherwise clip it (falling back to the viewport if nothing
 *  does). Computed from the icon's own position and the bubble's width —
 *  both readable without the bubble needing to already be unshifted first,
 *  so this is one synchronous pass, not a "reset to 0, remeasure next
 *  frame" two-step that left a real timing gap: the CSS hover transition
 *  starts immediately (pure CSS, no JS in the loop), so a correction that
 *  only lands a frame later could be caught mid-transition by a real
 *  mouse's timing even though it never showed up in automated testing. */
function keepInViewport(wrap) {
  const bubble = wrap.querySelector(".infotip__bubble");
  const icon = wrap.querySelector(".infotip__icon");
  if (!bubble || !icon) return;

  const iconRect = icon.getBoundingClientRect();
  const bubbleWidth = bubble.offsetWidth; // width alone isn't affected by the shift transform
  const iconCenter = iconRect.left + iconRect.width / 2;
  const naturalLeft = iconCenter - bubbleWidth / 2;
  const naturalRight = naturalLeft + bubbleWidth;

  const bounds = clippingAncestor(bubble)?.getBoundingClientRect();
  const leftEdge = Math.max(MARGIN, bounds ? bounds.left + MARGIN : MARGIN);
  const rightEdge = Math.min(window.innerWidth - MARGIN, bounds ? bounds.right - MARGIN : window.innerWidth - MARGIN);

  let shift = 0;
  if (naturalLeft < leftEdge) shift = leftEdge - naturalLeft;
  else if (naturalRight > rightEdge) shift = rightEdge - naturalRight;
  bubble.style.setProperty("--infotip-shift", `${Math.round(shift)}px`);
}

document.addEventListener("click", (event) => {
  const icon = event.target.closest(".infotip__icon");
  if (icon) {
    const wrap = icon.closest(".infotip");
    const willOpen = !wrap.classList.contains("is-open");
    closeAll();
    wrap.classList.toggle("is-open", willOpen);
    if (willOpen) keepInViewport(wrap);
    event.preventDefault();
    return;
  }
  if (!event.target.closest(".infotip__bubble")) closeAll();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeAll();
});

// Hover and keyboard focus reveal a bubble with no JS involved at all (pure
// CSS), so this is the only hook point left to correct their position too.
document.addEventListener("pointerover", (event) => {
  const wrap = event.target.closest(".infotip");
  if (wrap) keepInViewport(wrap);
});
document.addEventListener("focusin", (event) => {
  const wrap = event.target.closest(".infotip");
  if (wrap) keepInViewport(wrap);
});
