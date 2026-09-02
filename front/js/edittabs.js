// edittabs.js — groups the "ready · edit" controls into tabs (Surfaces /
// Colour / Adjust / Mask) so a growing list of tools has somewhere to live
// instead of one long scroll, and reuses the exact same grouping as a
// freely-draggable bottom sheet on narrow screens.
//
// Attributes/properties owned only by this file:
//   data-edittab       — which panel is showing: "surfaces"|"color"|"adjust"|"mask"
//                        set on both .editcard AND body, so CSS in .stage
//                        (a sibling of .rail, not a descendant of .editcard)
//                        can react to it too — see .maskdraw in styles.css,
//                        which only accepts pointer events on the Mask tab.
//   --sheet-offset      — mobile only: how many px the sheet is pushed down
//                        from fully open (0) toward its collapsed peek.
//                        Dragging the handle sets this directly and
//                        continuously — the sheet can stop anywhere between
//                        open and collapsed, not just those two states.
// Neither is read or written anywhere else — app.js's state machine
// (body[data-state] / body[data-ready]) is untouched by this file, and this
// file never reads it either. The card's own visibility still comes entirely
// from [data-when]/[data-when-ready] in styles.css, same as before.

const card = document.querySelector(".editcard");
let collapseSheetImpl = () => {};

/** Collapses the sheet to its peek — exported so app.js can call it when a
 *  brush stroke starts (an expanded sheet could otherwise cover the whole
 *  photo on a phone). A no-op if there's no card. */
export function collapseSheet() {
  collapseSheetImpl();
}

if (card) {
  const tabButtons = card.querySelectorAll("[data-edittab-btn]");
  const panels = card.querySelectorAll("[data-edittab-panel]");
  const handle = document.getElementById("editSheetHandle");
  const tabbar = card.querySelector(".edittabbar");
  const FALLBACK_PEEK = 148; // only used if the tab bar can't be measured at all

  /** How tall the collapsed "peek" needs to be to show the handle, title,
   *  and tab row in full — measured live off the actual rendered elements
   *  rather than a guessed constant, so a longer translated title, a wider
   *  font, or a future tab added to the row can never push the handle
   *  itself below the fold (which would make the sheet look like it
   *  vanished — there'd be nothing left poking up to grab). */
  function peekHeight() {
    if (!tabbar) return FALLBACK_PEEK;
    const cardTop = card.getBoundingClientRect().top;
    const tabbarBottom = tabbar.getBoundingClientRect().bottom;
    const measured = tabbarBottom - cardTop + 14; // a little breathing room below the tabs
    return measured > 40 ? measured : FALLBACK_PEEK; // sanity floor if measured while hidden
  }

  function selectTab(name) {
    card.setAttribute("data-edittab", name);
    document.body.setAttribute("data-edittab", name);
    for (const btn of tabButtons) {
      btn.setAttribute("aria-selected", String(btn.dataset.edittabBtn === name));
    }
    for (const panel of panels) {
      panel.hidden = panel.dataset.edittabPanel !== name;
    }
  }

  function currentOffset() {
    const raw = getComputedStyle(card).getPropertyValue("--sheet-offset");
    const n = parseFloat(raw);
    return Number.isNaN(n) ? card.getBoundingClientRect().height - peekHeight() : n;
  }

  /** Sets the sheet's vertical position directly, clamped between fully
   *  open (0) and its collapsed peek (sheet height − the live peek
   *  measurement) — the only two hard limits; everything between is fair
   *  game, unlike the old open-or-closed toggle. */
  function setOffset(px) {
    // A floor under sheetHeight in case this ever runs while the card is
    // mid-transition and briefly measures as unrealistically short — a
    // clamp derived from a bogus near-zero height would let the sheet (and
    // its own handle) end up pushed almost entirely off-screen.
    const sheetHeight = Math.max(card.getBoundingClientRect().height, peekHeight() + 60);
    const max = Math.max(0, sheetHeight - peekHeight());
    const clamped = Math.max(0, Math.min(max, px));
    card.style.setProperty("--sheet-offset", `${clamped}px`);
    // Still tracked as a coarse open/closed flag — nothing but CSS
    // affordances (e.g. a chevron direction) should ever key off this.
    card.setAttribute("data-sheetopen", String(clamped < max - 4));
  }

  function openFully() { setOffset(0); }
  function collapseFully() { setOffset(card.getBoundingClientRect().height); }

  for (const btn of tabButtons) {
    btn.addEventListener("click", () => {
      selectTab(btn.dataset.edittabBtn);
      // No-op on desktop (no such CSS state there); on narrow screens this
      // is what makes tapping a tab from the collapsed handle expand the
      // sheet — except Mask, whose whole point is then touching the photo,
      // which an expanded sheet could cover entirely on a phone. Brush
      // settings are still reachable by dragging the handle open by hand.
      if (btn.dataset.edittabBtn !== "mask") openFully();
    });
  }

  if (handle) {
    let dragStartY = null;
    let dragStartOffset = 0;

    handle.addEventListener("pointerdown", (event) => {
      dragStartY = event.clientY;
      dragStartOffset = currentOffset();
      card.classList.add("is-dragging");
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (dragStartY === null) return;
      setOffset(dragStartOffset + (event.clientY - dragStartY));
    });
    const endDrag = (event) => {
      if (dragStartY === null) return;
      const moved = Math.abs(event.clientY - dragStartY) > 6;
      dragStartY = null;
      card.classList.remove("is-dragging");
      // A tap (negligible movement) still toggles open/collapsed, same
      // shortcut the old click-only handle offered — a real drag just
      // leaves the sheet exactly wherever it was released.
      if (!moved) {
        const sheetHeight = card.getBoundingClientRect().height;
        const isMostlyCollapsed = currentOffset() > (sheetHeight - peekHeight()) / 2;
        if (isMostlyCollapsed) openFully(); else collapseFully();
      }
    };
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
  }

  collapseSheetImpl = collapseFully;

  // Sync the hidden attributes to whatever data-edittab the HTML already
  // declares.
  selectTab(card.getAttribute("data-edittab") || "surfaces");

  // The card starts hidden (idle/job-form/tracking/etc. all come before
  // ready·edit in the normal flow) — collapseFully() at that point would
  // read a height of 0 and bake in a useless "already collapsed to 0px"
  // that sticks once the card actually becomes visible. Wait for its first
  // real height instead of assuming module-load time is that moment.
  let collapsedOnce = false;
  new ResizeObserver(() => {
    if (collapsedOnce) return;
    if (card.getBoundingClientRect().height > 0) {
      collapsedOnce = true;
      collapseFully();
    }
  }).observe(card);
}
