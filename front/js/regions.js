/**
 * regions.js — the interactive region picker.
 *
 * Only used by the `Regions` operation. The backend hands back a label map
 * with no semantics: it knows this patch of pixels is one surface and that
 * patch is another, but not that either of them is a wall. Deciding which
 * regions belong together is the user's job, and this module is where they do
 * it — click a region to add it, click again to drop it, then name the set.
 *
 * It draws to its own canvas and never touches the compositor's. The output is
 * a `Set<number>` of region ids; turning that into a mask is
 * `labelMap.toMask()` in compositor.js, and from there it is an ordinary
 * layer. Keeping the picker out of the render path means the editing pipeline
 * stays exactly as it was — it has no idea this file exists.
 *
 * Cost: a full redraw is the photo plus one small canvas per selected region
 * (from the label map's cached per-region shapes), so it stays cheap enough to
 * run on hover. Nothing here re-reads pixels; the one per-pixel pass happened
 * in createLabelMap().
 */

import { CONFIG } from "./config.js";

const HIGHLIGHT = "#3f6b4a";

export function createRegionPicker({ canvas, onChange = () => {} } = {}) {
  const ctx = canvas.getContext("2d");

  let photo = null;      // HTMLImageElement — the original, drawn underneath
  let labelMap = null;   // from createLabelMap()
  let selected = new Set();
  let hovered = 0;
  let scale = 1;         // label-map pixels → canvas pixels
  let frame = 0;

  /* ---------------- geometry ---------------- */

  /**
   * The canvas is sized from the label map, not the photo. The backend
   * downscales to a 1536px longest edge before inference, so the map is often
   * smaller than the original — and every click has to land in label-map
   * coordinates to look up an id. The compositor rescales the resulting mask
   * back to full size on its own.
   */
  function fit() {
    if (!labelMap) return;
    const longEdge = Math.max(labelMap.width, labelMap.height);
    scale = Math.min(1, CONFIG.PREVIEW_MAX_EDGE / longEdge);
    canvas.width = Math.round(labelMap.width * scale);
    canvas.height = Math.round(labelMap.height * scale);
  }

  /** Pointer event → label-map pixel coordinates. */
  function toMapCoords(event) {
    const rect = canvas.getBoundingClientRect();
    // getBoundingClientRect is CSS pixels and the canvas may be letterboxed by
    // max-width, so go via the ratio rather than assuming 1:1.
    const x = ((event.clientX - rect.left) / rect.width) * labelMap.width;
    const y = ((event.clientY - rect.top) / rect.height) * labelMap.height;
    return { x, y };
  }

  /* ---------------- drawing ---------------- */

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; draw(); });
  }

  function paintRegion(id, alpha, outline) {
    const shape = labelMap.shapeOf(id);
    if (!shape) return;
    const x = shape.x * scale;
    const y = shape.y * scale;
    const w = shape.canvas.width * scale;
    const h = shape.canvas.height * scale;

    // Tint: the region's silhouette in mask magenta, laid over the photo.
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(tintedShape(id), x, y, w, h);
    ctx.restore();

    if (outline) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.drawImage(outlinedShape(id), x, y, w, h);
      ctx.restore();
    }
  }

  // Tinted and outlined variants are derived from the label map's cached
  // shape canvases and cached again here, so crossing the same region twice
  // costs nothing the second time.
  const tintCache = new Map();
  const outlineCache = new Map();

  function tintedShape(id) {
    if (tintCache.has(id)) return tintCache.get(id);
    const shape = labelMap.shapeOf(id);
    const out = document.createElement("canvas");
    out.width = shape.canvas.width;
    out.height = shape.canvas.height;
    const octx = out.getContext("2d");
    octx.drawImage(shape.canvas, 0, 0);
    octx.globalCompositeOperation = "source-in";
    octx.fillStyle = HIGHLIGHT;
    octx.fillRect(0, 0, out.width, out.height);
    tintCache.set(id, out);
    return out;
  }

  function outlinedShape(id) {
    if (outlineCache.has(id)) return outlineCache.get(id);
    const shape = labelMap.shapeOf(id);
    const out = document.createElement("canvas");
    out.width = shape.canvas.width;
    out.height = shape.canvas.height;
    const octx = out.getContext("2d");
    const band = Math.max(1, Math.round(2 / Math.max(scale, 0.2)));

    // Same erosion trick the compositor uses for its mask edge: draw the
    // shape, then punch out four offset copies, leaving a band at the border.
    octx.drawImage(shape.canvas, 0, 0);
    octx.globalCompositeOperation = "destination-out";
    for (const [dx, dy] of [[band, 0], [-band, 0], [0, band], [0, -band]]) {
      octx.drawImage(shape.canvas, dx, dy);
    }
    octx.globalCompositeOperation = "source-in";
    octx.fillStyle = HIGHLIGHT;
    octx.fillRect(0, 0, out.width, out.height);
    outlineCache.set(id, out);
    return out;
  }

  function draw() {
    if (!labelMap || !photo) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(photo, 0, 0, canvas.width, canvas.height);

    // Dim everything slightly so the highlighted regions carry the eye.
    if (selected.size || hovered) {
      ctx.save();
      ctx.fillStyle = "rgba(10, 12, 14, 0.28)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }

    for (const id of selected) paintRegion(id, 0.42, true);
    if (hovered && !selected.has(hovered)) paintRegion(hovered, 0.2, true);
  }

  /* ---------------- interaction ---------------- */

  function handleMove(event) {
    if (!labelMap) return;
    const { x, y } = toMapCoords(event);
    const id = labelMap.regionIdAt(x, y);
    if (id === hovered) return;
    hovered = id;
    canvas.style.cursor = id ? "pointer" : "default";
    schedule();
  }

  function handleLeave() {
    if (!hovered) return;
    hovered = 0;
    schedule();
  }

  function handleClick(event) {
    if (!labelMap) return;
    const { x, y } = toMapCoords(event);
    const id = labelMap.regionIdAt(x, y);
    if (!id) return;                     // background is not selectable
    toggle(id);
  }

  function toggle(id) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    schedule();
    onChange(new Set(selected));
  }

  canvas.addEventListener("pointermove", handleMove);
  canvas.addEventListener("pointerleave", handleLeave);
  canvas.addEventListener("click", handleClick);

  // Keyboard path: the canvas is focusable, and Enter toggles whatever the
  // pointer last identified. Not a full substitute for clicking a picture,
  // but it keeps the control operable without a mouse.
  canvas.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (hovered) toggle(hovered);
  });

  /* ---------------- public surface ---------------- */

  return {
    /** @param {HTMLImageElement} originalImage @param {object} map from createLabelMap() */
    mount(originalImage, map) {
      photo = originalImage;
      labelMap = map;
      selected = new Set();
      hovered = 0;
      tintCache.clear();
      outlineCache.clear();
      fit();
      draw();
      onChange(new Set(selected));
    },

    /** Load an existing selection — a saved group being reopened. */
    setSelection(ids) {
      selected = new Set(ids);
      schedule();
      onChange(new Set(selected));
    },

    /**
     * Swap what's drawn underneath the region highlights, without touching
     * the label map or the current selection. `source` can be the plain
     * original image or a live canvas — draw() doesn't care which, it just
     * drawImage()s whatever it's given.
     *
     * This is how surfaces already painted stay visible while picking more
     * regions: the caller passes the compositor's own display canvas (the
     * current edited composite) instead of the flat, unedited photo.
     */
    setBackground(source) {
      photo = source;
      schedule();
    },

    clear() {
      if (!selected.size) return;
      selected.clear();
      schedule();
      onChange(new Set(selected));
    },

    get selection() { return new Set(selected); },
    get size() { return selected.size; },
    get map() { return labelMap; },

    /** Fraction of the frame the current selection covers, for the readout. */
    coverage() {
      if (!labelMap || !selected.size) return 0;
      let pixels = 0;
      for (const id of selected) pixels += labelMap.pixelsIn(id);
      return pixels / (labelMap.width * labelMap.height);
    },

    redraw: schedule,

    dispose() {
      photo = null;
      labelMap = null;
      selected = new Set();
      hovered = 0;
      tintCache.clear();
      outlineCache.clear();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
