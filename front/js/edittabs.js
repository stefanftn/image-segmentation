// edittabs.js — groups the "ready · edit" controls into tabs (Surfaces /
// Colour / Adjust / Mask) so a growing list of tools has somewhere to live
// instead of one long scroll, and reuses the exact same grouping as a bottom
// sheet on narrow screens.
//
// Two attributes, owned only by this file:
//   data-edittab      — which panel is showing: "surfaces"|"color"|"adjust"|"mask"
//                        set on both .editcard AND body, so CSS in .stage
//                        (a sibling of .rail, not a descendant of .editcard)
//                        can react to it too — see .maskdraw in styles.css,
//                        which only accepts pointer events on the Mask tab.
//   data-sheetopen     — mobile only: is the bottom sheet expanded
// Neither is read or written anywhere else — app.js's state machine
// (body[data-state] / body[data-ready]) is untouched by this file, and this
// file never reads it either. The card's own visibility still comes entirely
// from [data-when]/[data-when-ready] in styles.css, same as before.

const card = document.querySelector(".editcard");

if (card) {
  const tabButtons = card.querySelectorAll("[data-edittab-btn]");
  const panels = card.querySelectorAll("[data-edittab-panel]");
  const handle = document.getElementById("editSheetHandle");

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

  function setSheetOpen(open) {
    card.setAttribute("data-sheetopen", String(open));
  }

  for (const btn of tabButtons) {
    btn.addEventListener("click", () => {
      selectTab(btn.dataset.edittabBtn);
      // No-op on desktop (no such CSS state there); on narrow screens this
      // is what makes tapping a tab from the collapsed handle expand the
      // sheet — except Mask, whose whole point is then touching the photo,
      // which an expanded sheet could cover entirely on a phone. Brush
      // settings are still reachable by tapping the handle open by hand.
      if (btn.dataset.edittabBtn !== "mask") setSheetOpen(true);
    });
  }

  if (handle) {
    handle.addEventListener("click", () => {
      setSheetOpen(card.getAttribute("data-sheetopen") !== "true");
    });
  }

  // Sync the hidden attributes to whatever data-edittab the HTML already
  // declares, and start the mobile sheet collapsed.
  selectTab(card.getAttribute("data-edittab") || "surfaces");
  setSheetOpen(false);
}
