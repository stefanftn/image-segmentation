// warp.js — dragging the 4 perspective-warp corner handles.
//
// Standalone like brush.js/theme.js/etc: reads/writes only the active
// layer's edits.warpPoints (via compositor.setEdits, the same funnel every
// other control uses) and two DOM bits it owns outright (the SVG quad
// outline, the 4 handle buttons). It doesn't know about tabs — app.js
// decides when to call setVisible(), same relationship it has with
// brush.js and Mask-tab activity.
//
// Coordinate model matches brush.js: every pointer position is read as a
// FRACTION of the display canvas's own rendered box, which already accounts
// for the current zoom transform, so nothing here needs to know the zoom
// level. warpPoints are stored as those same 0..1 fractions (of the tile
// fill's own rectangle, not the mask) — see compositor.js's
// IDENTITY_WARP_POINTS and _warpPerspective.

import { IDENTITY_WARP_POINTS } from "./compositor.js";

export function createWarpTool({
  compositor,
  getActiveLayerId,
  displayCanvas,
  overlaySvg,
  quadPolygon,
  handlesContainer,
  onPointsCommitted = () => {},
}) {
  let dragIndex = null;

  function activeLayer() {
    const id = getActiveLayerId();
    return id ? compositor.getLayer(id) : null;
  }

  function render() {
    const layer = activeLayer();
    const points = layer?.edits.warpPoints || IDENTITY_WARP_POINTS;
    quadPolygon.setAttribute("points", points.map(([x, y]) => `${x},${y}`).join(" "));
    const handles = handlesContainer.querySelectorAll(".warphandle");
    handles.forEach((el, i) => {
      el.style.left = `${points[i][0] * 100}%`;
      el.style.top = `${points[i][1] * 100}%`;
    });
  }

  function fractionFor(clientX, clientY) {
    const rect = displayCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      fx: (clientX - rect.left) / rect.width,
      fy: (clientY - rect.top) / rect.height,
    };
  }

  function pointerDown(event) {
    dragIndex = Number(event.currentTarget.dataset.warpIndex);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function pointerMove(event) {
    if (dragIndex === null) return;
    const id = getActiveLayerId();
    const layer = id ? compositor.getLayer(id) : null;
    if (!layer) return;
    const frac = fractionFor(event.clientX, event.clientY);
    if (!frac) return;
    const next = (layer.edits.warpPoints || IDENTITY_WARP_POINTS).map((p) => [...p]);
    // A generous clamp, not a tight one — dragging a corner well outside the
    // frame is a legitimate way to push a texture into a steep, dramatic
    // angle. Just stop short of letting the quad fold back on itself.
    next[dragIndex] = [
      Math.max(-0.6, Math.min(1.6, frac.fx)),
      Math.max(-0.6, Math.min(1.6, frac.fy)),
    ];
    compositor.setEdits(id, { warpPoints: next });
    compositor.render();
    render();
  }

  function pointerUp() {
    if (dragIndex === null) return;
    dragIndex = null;
    onPointsCommitted();
  }

  for (const handle of handlesContainer.querySelectorAll(".warphandle")) {
    handle.addEventListener("pointerdown", pointerDown);
  }
  document.addEventListener("pointermove", pointerMove);
  document.addEventListener("pointerup", pointerUp);
  document.addEventListener("pointercancel", pointerUp);

  return {
    render,
    setVisible(visible) {
      overlaySvg.hidden = !visible;
      handlesContainer.hidden = !visible;
      if (visible) render();
    },
    reset() {
      const id = getActiveLayerId();
      if (!id) return;
      compositor.setEdits(id, { warpPoints: IDENTITY_WARP_POINTS.map((p) => [...p]) });
      compositor.render();
      render();
      onPointsCommitted();
    },
  };
}
