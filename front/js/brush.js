// brush.js — manual mask editing: paint pixels into the active layer's mask
// (Brush) or punch them out (Eraser), plus an optional magnifier while a
// stroke is down.
//
// Coordinate model, in one paragraph: every pointer position is first turned
// into a FRACTION of the display canvas's own rendered box —
// `(clientX - rect.left) / rect.width` — via getBoundingClientRect(), which
// already accounts for the CSS zoom transform on .canvasinner, so nothing
// here has to know the current zoom level at all. That fraction is then
// rescaled twice: once against the *preview* canvas's pixel size for the
// live stroke overlay (cheap, redrawn every pointermove), and once against
// the layer mask's own pixel size — which can be a very different
// resolution — for the single, real commit on pointerup. The brush size
// slider is likewise a fraction of the rendered width, not a fixed mask-pixel
// count, so its on-screen footprint stays constant across zoom levels (zoom
// in for more precision, same as any other paint tool) while its readout
// stays in the screen pixels the person actually set.
//
// A stroke becomes exactly one compositor mask update and exactly one
// history checkpoint (via onStrokeCommitted) — never one per pointermove.

export function createBrushTool({
  compositor,
  getActiveLayerId,
  canvasBox,
  displayCanvas,
  drawCanvas,
  cursorEl,
  magnifierEl,
  magnifierCanvas,
  onStrokeCommitted = () => {},
}) {
  let mode = "brush"; // "brush" | "eraser"
  let sizePx = 40; // on-screen diameter, in CSS pixels, at the current zoom
  let magnifierEnabled = true;
  let active = false; // Mask tab is the one showing
  let stroke = null; // { points: [{fx,fy}], radiusFrac }

  function setMode(next) { mode = next === "eraser" ? "eraser" : "brush"; }
  function setSize(px) { sizePx = Math.max(2, Number(px) || 40); }
  function setMagnifierEnabled(on) {
    magnifierEnabled = Boolean(on);
    if (!magnifierEnabled) magnifierEl.hidden = true;
  }
  function setActive(on) {
    active = Boolean(on);
    if (!active) {
      cursorEl.hidden = true;
      magnifierEl.hidden = true;
    }
  }

  function rectFraction(clientX, clientY) {
    const rect = displayCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      fx: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      fy: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
      rect,
    };
  }

  function updateCursor(clientX, clientY) {
    if (!active) return;
    const boxRect = canvasBox.getBoundingClientRect();
    cursorEl.style.left = `${clientX - boxRect.left}px`;
    cursorEl.style.top = `${clientY - boxRect.top}px`;
    cursorEl.style.width = `${sizePx}px`;
    cursorEl.style.height = `${sizePx}px`;
    cursorEl.classList.toggle("brushcursor--eraser", mode === "eraser");
    cursorEl.hidden = false;
  }

  function updateMagnifier(clientX, clientY) {
    if (!active || !magnifierEnabled) { magnifierEl.hidden = true; return; }
    const frac = rectFraction(clientX, clientY);
    if (!frac) return;
    const dispX = frac.fx * displayCanvas.width;
    const dispY = frac.fy * displayCanvas.height;
    const view = magnifierCanvas.width; // square, see HTML (120x120)
    const zoom = 3;
    const srcSize = view / zoom;
    const srcX = dispX - srcSize / 2;
    const srcY = dispY - srcSize / 2;
    const mctx = magnifierCanvas.getContext("2d");
    mctx.imageSmoothingEnabled = false;
    mctx.clearRect(0, 0, view, view);
    // The last full composite (may be a frame stale mid-stroke)...
    mctx.drawImage(displayCanvas, srcX, srcY, srcSize, srcSize, 0, 0, view, view);
    // ...with the in-progress stroke's own live preview layered on top, so
    // what's actually being painted right now is visible before it commits
    // (the real mask update only happens on pointerup, not every move).
    mctx.drawImage(drawCanvas, srcX, srcY, srcSize, srcSize, 0, 0, view, view);

    // The brush's real footprint, at the same zoom as the crop above — the
    // same radiusFrac math a stroke commits with, just evaluated live.
    const radiusFrac = (sizePx / 2) / frac.rect.width;
    const radiusInMagnifier = radiusFrac * displayCanvas.width * zoom;
    mctx.beginPath();
    mctx.arc(view / 2, view / 2, radiusInMagnifier, 0, Math.PI * 2);
    mctx.lineWidth = 1.5;
    mctx.strokeStyle = mode === "brush" ? "rgba(163,230,53,.9)" : "rgba(255,138,128,.9)";
    mctx.stroke();

    const boxRect = canvasBox.getBoundingClientRect();
    const half = magnifierEl.offsetWidth / 2 || view / 2;
    let left = clientX - boxRect.left - half;
    let top = clientY - boxRect.top - half - half * 2.2; // float above the fingertip/cursor
    left = Math.max(4, Math.min(boxRect.width - half * 2 - 4, left));
    top = Math.max(4, top);
    magnifierEl.style.left = `${left}px`;
    magnifierEl.style.top = `${top}px`;
    magnifierEl.hidden = false;
  }

  function drawLivePoint(prev, curr, radiusPx) {
    const dctx = drawCanvas.getContext("2d");
    const color = mode === "brush" ? "rgba(163,230,53,.55)" : "rgba(255,138,128,.55)";
    dctx.lineCap = "round";
    dctx.lineJoin = "round";
    dctx.strokeStyle = color;
    dctx.fillStyle = color;
    dctx.lineWidth = radiusPx * 2;
    dctx.beginPath();
    if (prev) {
      dctx.moveTo(prev.x, prev.y);
      dctx.lineTo(curr.x, curr.y);
      dctx.stroke();
    }
    dctx.beginPath();
    dctx.arc(curr.x, curr.y, radiusPx, 0, Math.PI * 2);
    dctx.fill();
  }

  function commitStroke() {
    const id = getActiveLayerId();
    const layer = id ? compositor.getLayer(id) : null;
    if (!layer || !stroke || stroke.points.length === 0) { stroke = null; return; }

    const oldMask = layer.mask;
    const mask = document.createElement("canvas");
    mask.width = oldMask.width;
    mask.height = oldMask.height;
    const mctx = mask.getContext("2d");
    mctx.drawImage(oldMask, 0, 0);

    const radius = stroke.radiusFrac * mask.width;
    mctx.lineCap = "round";
    mctx.lineJoin = "round";
    mctx.lineWidth = radius * 2;
    mctx.globalCompositeOperation = mode === "brush" ? "source-over" : "destination-out";
    mctx.strokeStyle = "#fff";
    mctx.fillStyle = "#fff";

    let prev = null;
    for (const p of stroke.points) {
      const x = p.fx * mask.width;
      const y = p.fy * mask.height;
      if (prev) {
        mctx.beginPath();
        mctx.moveTo(prev.x, prev.y);
        mctx.lineTo(x, y);
        mctx.stroke();
      }
      mctx.beginPath();
      mctx.arc(x, y, radius, 0, Math.PI * 2);
      mctx.fill();
      prev = { x, y };
    }
    mctx.globalCompositeOperation = "source-over";

    compositor.updateLayerSource(id, { mask });
    compositor.render();

    const dctx = drawCanvas.getContext("2d");
    dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);

    stroke = null;
    onStrokeCommitted();
  }

  function pointerDown(event) {
    if (!active) return;
    const id = getActiveLayerId();
    if (!id) return;
    const frac = rectFraction(event.clientX, event.clientY);
    if (!frac) return;

    // Preview canvas tracks the display canvas 1:1 so live strokes line up
    // pixel-for-pixel with no separate scale math.
    if (drawCanvas.width !== displayCanvas.width || drawCanvas.height !== displayCanvas.height) {
      drawCanvas.width = displayCanvas.width;
      drawCanvas.height = displayCanvas.height;
    }

    const radiusFrac = (sizePx / 2) / frac.rect.width;
    stroke = { points: [{ fx: frac.fx, fy: frac.fy }], radiusFrac };
    drawLivePoint(null, { x: frac.fx * displayCanvas.width, y: frac.fy * displayCanvas.height }, radiusFrac * displayCanvas.width);
    drawCanvas.setPointerCapture?.(event.pointerId);
    updateMagnifier(event.clientX, event.clientY);
    event.preventDefault();
  }

  function pointerMove(event) {
    updateCursor(event.clientX, event.clientY);
    if (!stroke) return;
    const frac = rectFraction(event.clientX, event.clientY);
    if (!frac) return;
    const prevFrac = stroke.points[stroke.points.length - 1];
    stroke.points.push({ fx: frac.fx, fy: frac.fy });
    drawLivePoint(
      { x: prevFrac.fx * displayCanvas.width, y: prevFrac.fy * displayCanvas.height },
      { x: frac.fx * displayCanvas.width, y: frac.fy * displayCanvas.height },
      stroke.radiusFrac * displayCanvas.width,
    );
    updateMagnifier(event.clientX, event.clientY);
    event.preventDefault();
  }

  function pointerUp(event) {
    magnifierEl.hidden = true;
    if (!stroke) return;
    drawCanvas.releasePointerCapture?.(event.pointerId);
    commitStroke();
  }

  drawCanvas.addEventListener("pointerdown", pointerDown);
  drawCanvas.addEventListener("pointermove", pointerMove);
  drawCanvas.addEventListener("pointerup", pointerUp);
  drawCanvas.addEventListener("pointercancel", pointerUp);
  drawCanvas.addEventListener("pointerleave", () => { cursorEl.hidden = true; });

  return { setMode, setSize, setMagnifierEnabled, setActive };
}
