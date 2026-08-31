/**
 * compositor.js — the masking and compositing engine (spec §6).
 *
 * The rule that keeps this correct: every render is recomputed from the
 * untouched original plus the mask. Nothing is ever painted on top of the
 * previous frame. Drag a slider out and back and you land exactly where you
 * started, because the frame you land on was computed from the source, not
 * from the frame before it.
 *
 * Pipeline, per render:
 *
 *   base            the original, at working scale
 *    └─ per layer:
 *        maskLayer  original pixels, clipped by the mask (destination-in)
 *        adjusted   maskLayer + hue/saturate filter, then optional tint
 *                   via the "color" blend (hue+sat from the swatch,
 *                   luminosity from the photo — so shadows survive)
 *        texture    tiled pattern, clipped to the same mask, multiplied on
 *                   so the original shading still reads through
 *
 * Cost control: the per-pixel JS loop happens exactly once per mask, in
 * normalizeMask(). The hot path — slider dragging — is drawImage calls and
 * native filters only. On very large images the filter + blend chain is the
 * expensive part; if it ever stops holding 60fps, that chain is the piece to
 * move to WebGL (one fragment shader doing hue/sat/tint/texture in a single
 * pass), keeping this module's public surface unchanged.
 */

import { CONFIG } from "./config.js";

/* ------------------------------------------------------------------ *
 * Image loading
 * ------------------------------------------------------------------ */

/**
 * Load a URL into an <img>.
 *
 * crossOrigin is set BEFORE .src, always, and that ordering is not
 * cosmetic: setting it afterwards has no effect on a request already in
 * flight, and the result is a tainted canvas whose getImageData throws a
 * SecurityError — with the network tab showing a perfectly successful 200.
 * That failure mode is confusing enough to be worth the one-line comment.
 */
export function loadImage(src, { crossOrigin = "anonymous" } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = crossOrigin; // before .src — see above
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The image could not be decoded."));
    img.src = src;
  });
}

/** Load a Blob and release its object URL as soon as the pixels are decoded. */
export async function loadImageFromBlob(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    if (img.decode) await img.decode().catch(() => {});
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function makeCanvas(width, height) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

/* ------------------------------------------------------------------ *
 * Mask normalization — the one per-pixel pass
 * ------------------------------------------------------------------ */

/**
 * Turn whatever the backend sent into a clip layer: white pixels, alpha
 * carrying the mask.
 *
 * Masks arrive in two shapes. Some have a real alpha channel. Most are plain
 * grayscale PNGs where "inside the entity" means "bright" — those need their
 * luminance moved into alpha, thresholded at CONFIG.MASK_THRESHOLD. Doing it
 * here, once, is what keeps the render path free of per-pixel JS.
 *
 * CONFIG.MASK_FEATHER widens the cut into a short ramp. A hard binary cut
 * leaves visible stair-stepping on any diagonal edge, and a repainted wall
 * with a jagged edge reads as broken even when the mask is right.
 *
 * @returns {{canvas: HTMLCanvasElement, coverage: number}} coverage is the
 *          fraction of the frame inside the mask — useful as a sanity check:
 *          0 means the model found nothing.
 */
export function normalizeMask(maskImg) {
  const width = maskImg.naturalWidth || maskImg.width;
  const height = maskImg.naturalHeight || maskImg.height;
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(maskImg, 0, 0);

  // Throws SecurityError on a tainted canvas — surfaced as a CORS problem.
  let image;
  try {
    image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    throw new Error("MASK_TAINTED");
  }
  const data = image.data;

  // Does this mask carry meaningful alpha, or is it flat-opaque grayscale?
  let hasAlpha = false;
  const stride = Math.max(4, Math.floor(data.length / 4 / 4096) * 4);
  for (let i = 3; i < data.length; i += stride) {
    if (data[i] < 250) { hasAlpha = true; break; }
  }

  const threshold = CONFIG.MASK_THRESHOLD;
  const feather = Math.max(0, CONFIG.MASK_FEATHER);
  const low = threshold - feather;
  const span = feather * 2 || 1;

  let inside = 0;
  for (let i = 0; i < data.length; i += 4) {
    const value = hasAlpha
      ? data[i + 3]
      // Rec. 601 luma: matches how a human reads a grayscale mask.
      : (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;

    let alpha;
    if (feather === 0) {
      alpha = value >= threshold ? 255 : 0;
    } else {
      const t = (value - low) / span;
      alpha = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255);
    }

    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = alpha;
    if (alpha > 127) inside += 1;
  }

  ctx.putImageData(image, 0, 0);
  return { canvas, coverage: inside / (canvas.width * canvas.height) };
}

/* ------------------------------------------------------------------ *
 * Label maps — the Regions operation
 * ------------------------------------------------------------------ */

/**
 * Read a SAM label map once and answer questions about it cheaply after.
 *
 * A label map is not a mask: every pixel's grayscale value is the id of the
 * visual region it belongs to (0 = background, 1–254 = a region), with no
 * semantic meaning attached to any of them. Turning that into a mask is this
 * client's job, and the raw material for it is a per-pixel read — so, in the
 * same spirit as normalizeMask(), the per-pixel work happens exactly once
 * here and everything afterwards is lookups and small canvases.
 *
 * The single pass builds a histogram and a bounding box per id, which is what
 * makes the interactive picker affordable: hovering a region needs only that
 * region's box, not another sweep of the frame.
 */
export function createLabelMap(labelImage) {
  const width = labelImage.naturalWidth || labelImage.width;
  const height = labelImage.naturalHeight || labelImage.height;
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(labelImage, 0, 0);

  let image;
  try {
    image = ctx.getImageData(0, 0, width, height);
  } catch {
    throw new Error("MASK_TAINTED"); // same CORS story as normalizeMask
  }
  const data = image.data;

  // Ids are 0–254, so fixed-size arrays beat any map here.
  const counts = new Uint32Array(256);
  const minX = new Uint32Array(256).fill(width);
  const minY = new Uint32Array(256).fill(height);
  const maxX = new Uint32Array(256);
  const maxY = new Uint32Array(256);

  // One byte per pixel: the id plane, kept for lookups without re-reading RGBA.
  const ids = new Uint8Array(width * height);

  for (let p = 0, i = 0; p < ids.length; p += 1, i += 4) {
    // The map is grayscale; the red channel carries the id. Alpha is ignored
    // deliberately — a fully transparent PNG pixel is still region 0.
    const id = data[i];
    ids[p] = id;
    counts[id] += 1;
    const x = p % width;
    const y = (p - x) / width;
    if (x < minX[id]) minX[id] = x;
    if (x > maxX[id]) maxX[id] = x;
    if (y < minY[id]) minY[id] = y;
    if (y > maxY[id]) maxY[id] = y;
  }

  const total = width * height;
  const present = [];
  for (let id = 1; id < 256; id += 1) if (counts[id] > 0) present.push(id);

  const shapeCache = new Map();

  return {
    width,
    height,
    /** Region ids actually present, background excluded, largest first. */
    regionIds: present.slice().sort((a, b) => counts[b] - counts[a]),
    regionCount: present.length,
    /** Fraction of the frame that is any region at all — 0 means the model
     *  found nothing, which is a different failure from "no wall here". */
    labelledFraction: (total - counts[0]) / total,

    /** Region id at a point in label-map pixel coordinates; 0 is background. */
    regionIdAt(x, y) {
      const px = Math.floor(x);
      const py = Math.floor(y);
      if (px < 0 || py < 0 || px >= width || py >= height) return 0;
      return ids[py * width + px];
    },

    pixelsIn(id) { return counts[id] ?? 0; },

    boundsOf(id) {
      if (!counts[id]) return null;
      return { x: minX[id], y: minY[id], w: maxX[id] - minX[id] + 1, h: maxY[id] - minY[id] + 1 };
    },

    /**
     * A single region as a small white-on-transparent canvas, positioned by
     * its bounding box. Cached, because the picker asks for the same region
     * every time the pointer crosses it.
     * @returns {{canvas: HTMLCanvasElement, x: number, y: number}|null}
     */
    shapeOf(id) {
      if (!counts[id]) return null;
      if (shapeCache.has(id)) return shapeCache.get(id);

      const box = { x: minX[id], y: minY[id], w: maxX[id] - minX[id] + 1, h: maxY[id] - minY[id] + 1 };
      const shape = makeCanvas(box.w, box.h);
      const sctx = shape.getContext("2d");
      const out = sctx.createImageData(box.w, box.h);
      const od = out.data;
      for (let row = 0; row < box.h; row += 1) {
        const src = (box.y + row) * width + box.x;
        const dst = row * box.w;
        for (let col = 0; col < box.w; col += 1) {
          if (ids[src + col] === id) {
            const o = (dst + col) * 4;
            od[o] = 255; od[o + 1] = 255; od[o + 2] = 255; od[o + 3] = 255;
          }
        }
      }
      sctx.putImageData(out, 0, 0);
      const entry = { canvas: shape, x: box.x, y: box.y };
      shapeCache.set(id, entry);
      return entry;
    },

    /**
     * Resolve a selection to a mask, in exactly the shape normalizeMask()
     * returns — so addLayer() and everything downstream cannot tell which
     * operation produced the layer.
     *
     * A hard cut, no feathering: region boundaries in a label map are already
     * where the model decided one surface stops and the next begins, and
     * softening them would bleed one region's edit into its neighbour.
     */
    toMask(selectedIds) {
      const wanted = new Uint8Array(256);
      for (const id of selectedIds) wanted[id & 0xff] = 1;
      wanted[0] = 0; // background is never selectable

      const mask = makeCanvas(width, height);
      const mctx = mask.getContext("2d");
      const out = mctx.createImageData(width, height);
      const od = out.data;

      let inside = 0;
      for (let p = 0, o = 0; p < ids.length; p += 1, o += 4) {
        if (wanted[ids[p]]) {
          od[o] = 255; od[o + 1] = 255; od[o + 2] = 255; od[o + 3] = 255;
          inside += 1;
        }
      }
      mctx.putImageData(out, 0, 0);
      return { canvas: mask, coverage: inside / total };
    },
  };
}

/**
 * Convenience for the common case: label map image plus selected ids in,
 * `{ canvas, coverage }` out. Building a LabelMap is the expensive part, so
 * anything resolving more than one selection from the same map — restoring a
 * set of saved groups, for instance — should build it once with
 * createLabelMap() and call `toMask` per selection instead.
 */
export function maskFromLabelMap(labelImageOrMap, selectedIds) {
  const map = typeof labelImageOrMap?.toMask === "function"
    ? labelImageOrMap
    : createLabelMap(labelImageOrMap);
  return map.toMask(selectedIds);
}

/* ------------------------------------------------------------------ *
 * Procedural textures
 * ------------------------------------------------------------------ */

/**
 * Tiles are generated rather than shipped as assets: no extra requests, no
 * CORS surface, and they stay crisp at any working scale. They sit in the
 * light half of the range because they are composited with "multiply" —
 * white leaves the photo untouched, so only the drawn detail darkens.
 */
function tile(size, paint) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext("2d");
  paint(ctx, size);
  return c;
}

const TILE = 128;

export const TEXTURES = [
  { id: "none", label: "none", build: null },

  {
    id: "brick",
    label: "brick",
    build: () => tile(TILE, (ctx, s) => {
      ctx.fillStyle = "#d8d2cb"; ctx.fillRect(0, 0, s, s);      // mortar
      ctx.fillStyle = "#f2efeb";                                 // face
      const h = s / 4, w = s / 2;
      for (let row = 0; row < 4; row += 1) {
        const offset = row % 2 ? -w / 2 : 0;
        for (let col = -1; col < 3; col += 1) {
          ctx.fillRect(col * w + offset + 2, row * h + 2, w - 4, h - 4);
        }
      }
    }),
  },

  {
    id: "plaster",
    label: "plaster",
    build: () => tile(TILE, (ctx, s) => {
      ctx.fillStyle = "#f4f2ee"; ctx.fillRect(0, 0, s, s);
      // value noise: many soft low-contrast dabs read as troweled plaster
      for (let i = 0; i < 2600; i += 1) {
        const g = 205 + Math.random() * 45;
        ctx.fillStyle = `rgba(${g | 0},${g | 0},${(g - 4) | 0},0.5)`;
        ctx.beginPath();
        ctx.arc(Math.random() * s, Math.random() * s, Math.random() * 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }),
  },

  {
    id: "wood",
    label: "wood",
    build: () => tile(TILE, (ctx, s) => {
      ctx.fillStyle = "#f0e9df"; ctx.fillRect(0, 0, s, s);
      ctx.lineWidth = 1;
      for (let y = 0; y < s; y += 3) {
        const dark = 190 + Math.random() * 50;
        ctx.strokeStyle = `rgba(${dark | 0},${(dark - 20) | 0},${(dark - 45) | 0},0.55)`;
        ctx.beginPath();
        for (let x = 0; x <= s; x += 8) {
          const wobble = Math.sin((x / s) * Math.PI * 2 + y) * 1.6;
          if (x === 0) ctx.moveTo(x, y + wobble); else ctx.lineTo(x, y + wobble);
        }
        ctx.stroke();
      }
    }),
  },

  {
    id: "tile",
    label: "tile",
    build: () => tile(TILE, (ctx, s) => {
      ctx.fillStyle = "#cfcac4"; ctx.fillRect(0, 0, s, s);       // grout
      ctx.fillStyle = "#f6f5f2";
      const n = 4, step = s / n;
      for (let y = 0; y < n; y += 1) {
        for (let x = 0; x < n; x += 1) {
          ctx.fillRect(x * step + 1.5, y * step + 1.5, step - 3, step - 3);
        }
      }
    }),
  },

  {
    id: "weave",
    label: "weave",
    build: () => tile(TILE, (ctx, s) => {
      ctx.fillStyle = "#f3f1ec"; ctx.fillRect(0, 0, s, s);
      ctx.strokeStyle = "rgba(150,145,138,0.42)";
      ctx.lineWidth = 2;
      for (let i = -s; i < s * 2; i += 6) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + s, s); ctx.stroke();
      }
      ctx.strokeStyle = "rgba(150,145,138,0.24)";
      for (let i = -s; i < s * 2; i += 6) {
        ctx.beginPath(); ctx.moveTo(i, s); ctx.lineTo(i + s, 0); ctx.stroke();
      }
    }),
  },

  {
    id: "concrete",
    label: "concrete",
    build: () => tile(TILE, (ctx, s) => {
      ctx.fillStyle = "#eeedea"; ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 1400; i += 1) {
        const g = 170 + Math.random() * 70;
        ctx.fillStyle = `rgba(${g | 0},${g | 0},${g | 0},0.35)`;
        ctx.fillRect(Math.random() * s, Math.random() * s, 1.6, 1.6);
      }
      ctx.strokeStyle = "rgba(160,158,154,0.30)";
      ctx.lineWidth = 1;
      for (let i = 0; i < 5; i += 1) {
        ctx.beginPath();
        ctx.moveTo(Math.random() * s, 0);
        ctx.lineTo(Math.random() * s, s);
        ctx.stroke();
      }
    }),
  },
];

const tileCache = new Map();

/** Lazily built, then cached — a tile is generated at most once per session. */
export function getTextureTile(id) {
  if (!id || id === "none") return null;
  if (tileCache.has(id)) return tileCache.get(id);
  const spec = TEXTURES.find((t) => t.id === id);
  if (!spec?.build) return null;
  const canvas = spec.build();
  tileCache.set(id, canvas);
  return canvas;
}

/* ------------------------------------------------------------------ *
 * Edits
 * ------------------------------------------------------------------ */

export function defaultEdits() {
  return {
    tint: null,          // "#rrggbb" or null for "keep the original colour"
    tintStrength: 1,      // 0…1 — how much of the tint blend to apply
    hue: 0,              // degrees, -180…180
    saturation: 100,     // percent
    texture: "none",
    textureStrength: 0.7,
    textureRotation: 0,   // degrees, -180…180 — matches the tile to a wall's angle
    textureDepth: 0,       // -100…100 — one side of the tile compressed toward
                            // the other, approximating a wall receding at an angle
  };
}

export function isUnedited(edits) {
  const d = defaultEdits();
  return edits.tint === d.tint
    && edits.tintStrength === d.tintStrength
    && edits.hue === d.hue
    && edits.saturation === d.saturation
    && edits.texture === d.texture
    && edits.textureStrength === d.textureStrength
    && edits.textureRotation === d.textureRotation
    && edits.textureDepth === d.textureDepth;
}

/**
 * Destination-strip boundaries for the texture depth warp, as x-coordinates
 * across `totalWidth`. Pure and side-effect-free on purpose — the actual
 * canvas work (warpDepth, below) just draws source strips into whatever
 * boundaries this returns, so the geometry can be checked without a canvas
 * at all.
 *
 * `depth` runs -1…1. At 0 every strip is the same width (no warp). Moving
 * positive widens the left strips and narrows the right ones — one edge
 * reads as nearer (larger, more of the tile's detail), the other as farther
 * (compressed) — the closest a 2D affine-only canvas can get to suggesting
 * a wall's texture receding at an angle, without a true perspective/
 * homography transform (which Canvas 2D doesn't support — that would need
 * WebGL). Negative depth mirrors the effect to the other side.
 *
 * A strip's weight never reaches zero: total collapse would erase the
 * tile's content at that edge rather than just compressing it.
 */
export function depthStripBoundaries(totalWidth, strips, depth) {
  const clamped = Math.max(-1, Math.min(1, depth));
  const weights = [];
  for (let i = 0; i < strips; i += 1) {
    const t = strips === 1 ? 0.5 : i / (strips - 1); // 0 (left) … 1 (right)
    weights.push(Math.max(0.08, 1 + clamped * (1 - 2 * t)));
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  const boundaries = [0];
  let x = 0;
  for (let i = 0; i < strips; i += 1) {
    x += (weights[i] / sum) * totalWidth;
    boundaries.push(x);
  }
  boundaries[strips] = totalWidth; // pin the far edge exactly — floats drift
  return boundaries;
}

/* ------------------------------------------------------------------ *
 * Compositor
 * ------------------------------------------------------------------ */

export class Compositor {
  /**
   * @param {HTMLCanvasElement} displayCanvas the visible, edited canvas
   * @param {object} [opts]
   * @param {HTMLCanvasElement} [opts.beforeCanvas] optional second canvas kept
   *        in lockstep with displayCanvas, but always showing the untouched
   *        original at the same working scale — the "before" half of the
   *        before/after compare slider. Nothing renders into it unless it's
   *        provided, so callers that don't need the compare view pay nothing.
   */
  constructor(displayCanvas, { beforeCanvas = null } = {}) {
    this.display = displayCanvas;
    this.ctx = displayCanvas.getContext("2d");
    this.beforeCanvas = beforeCanvas;
    this.original = null;
    /** @type {Array<{id:string,label:string,mask:HTMLCanvasElement,coverage:number,edits:object}>} */
    this.layers = [];
    this.showMaskEdge = false;
    this._stage = null;    // cached working-scale stage
    this._scratch = null;
    this._scratch2 = null;
    this._scratch3 = null;
  }

  /* ---------------- sources ---------------- */

  setOriginal(img) {
    this.original = img;
    this.layers = [];
    this._stage = null;
  }

  get size() {
    if (!this.original) return { width: 0, height: 0 };
    return {
      width: this.original.naturalWidth || this.original.width,
      height: this.original.naturalHeight || this.original.height,
    };
  }

  /** Working scale for live preview. Export ignores this and uses 1. */
  get previewScale() {
    const { width, height } = this.size;
    const longEdge = Math.max(width, height);
    if (!longEdge) return 1;
    return Math.min(1, CONFIG.PREVIEW_MAX_EDGE / longEdge);
  }

  /**
   * Add a mask as an independently editable layer (spec §10 falls out of
   * this for free: layers composite in the order they were added).
   *
   * `label` is display text only — "Wall (interior)" for a Segment result,
   * the user's name for a saved region selection. It replaces the old
   * `prompt` field, which named a concept the backend no longer has.
   *
   * Either a `maskImage` (a mask the backend produced) or an already-built
   * `mask` canvas (a selection resolved from a label map) can be passed. The
   * engine cannot tell the difference past this point, and that is the whole
   * design: how a mask was arrived at is not the compositor's business.
   */
  addLayer({ id, label, maskImage, mask = null, coverage = null }) {
    const built = mask
      ? { canvas: mask, coverage: coverage ?? 0 }
      : normalizeMask(maskImage);
    const layer = {
      id,
      label,
      mask: built.canvas,
      coverage: built.coverage,
      edits: defaultEdits(),
    };
    this.layers.push(layer);
    this._stage = null;
    return layer;
  }

  getLayer(id) { return this.layers.find((l) => l.id === id) ?? null; }

  removeLayer(id) {
    this.layers = this.layers.filter((l) => l.id !== id);
    this._stage = null;
  }

  /**
   * Replace a layer's mask/coverage in place, keeping its edits (colour,
   * texture, everything) exactly as they were. Used when the region
   * selection behind an already-materialized surface changes — adjusting a
   * saved group's regions and re-applying should refine that surface, not
   * discard whatever colour was already dialled in and start a fresh one.
   * `label` is optional so a caller that only touched the mask doesn't have
   * to also know or repeat the current label.
   */
  updateLayerSource(id, { mask, coverage, label } = {}) {
    const layer = this.getLayer(id);
    if (!layer) return null;
    if (mask) layer.mask = mask;
    if (coverage != null) layer.coverage = coverage;
    if (label != null) layer.label = label;
    this._stage = null;
    return layer;
  }

  /**
   * Change a layer's id without touching anything else about it — its
   * position in draw order, its edits, its mask, all stay put. Used to
   * reconcile a not-yet-saved draft surface's temporary id with its real
   * group id the moment a save succeeds, so the surface that was already
   * being edited becomes *the* representation of that saved group rather
   * than sitting alongside a second, server-synced copy of itself.
   *
   * Invalidates the stage cache: `stage.layers` is keyed by id, and a
   * renamed layer would otherwise be drawn with no clipped canvas to find.
   */
  renameLayer(oldId, newId) {
    if (oldId === newId) return true;
    const layer = this.getLayer(oldId);
    if (!layer) return false;
    layer.id = newId;
    this._stage = null;
    return true;
  }

  /**
   * Move a layer earlier or later in draw order — later layers paint on top,
   * so this is z-order, not the stage. Swaps with the adjacent element rather
   * than resorting the whole array, so unrelated layers never change position
   * relative to each other.
   *
   * The stage cache doesn't need invalidating: `stage.layers` is a Map keyed
   * by id holding each layer's pre-clipped canvas, which draw order doesn't
   * touch. Only `_composite()`'s loop over `this.layers` needs the new order,
   * and it reads that array fresh on every render.
   *
   * @param {string} id
   * @param {number} delta -1 to move toward the back, +1 toward the front
   * @returns {boolean} whether the move happened (false at an array boundary
   *          or for an unknown id)
   */
  moveLayer(id, delta) {
    const from = this.layers.findIndex((l) => l.id === id);
    if (from < 0) return false;
    const to = from + delta;
    if (to < 0 || to >= this.layers.length) return false;
    [this.layers[from], this.layers[to]] = [this.layers[to], this.layers[from]];
    return true;
  }

  setEdits(id, patch) {
    const layer = this.getLayer(id);
    if (!layer) return null;
    layer.edits = { ...layer.edits, ...patch };
    return layer.edits;
  }

  /* ---------------- stage ---------------- */

  /**
   * Build (and cache) the two things every frame starts from: the original at
   * working scale, and one mask-clipped copy of it per layer. This is the
   * "once per mask, not per slider tick" half of §6.1.
   */
  _buildStage(scale) {
    const { width, height } = this.size;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    const base = makeCanvas(w, h);
    const bctx = base.getContext("2d");
    bctx.imageSmoothingQuality = "high";
    bctx.drawImage(this.original, 0, 0, w, h);

    const layers = new Map();
    for (const layer of this.layers) {
      const clipped = makeCanvas(w, h);
      const cctx = clipped.getContext("2d");
      cctx.imageSmoothingQuality = "high";
      cctx.drawImage(this.original, 0, 0, w, h);        // 1. the full original
      cctx.globalCompositeOperation = "destination-in";
      cctx.drawImage(layer.mask, 0, 0, w, h);           // 2. keep only the mask
      cctx.globalCompositeOperation = "source-over";
      layers.set(layer.id, clipped);
    }

    return { scale, width: w, height: h, base, layers };
  }

  _stageFor(scale) {
    if (this._stage && Math.abs(this._stage.scale - scale) < 1e-6) return this._stage;
    const stage = this._buildStage(scale);
    if (scale === this.previewScale) this._stage = stage;   // only cache the preview
    return stage;
  }

  _scratchFor(which, w, h) {
    const key = which === 1 ? "_scratch" : which === 2 ? "_scratch2" : "_scratch3";
    let c = this[key];
    if (!c || c.width !== w || c.height !== h) {
      c = makeCanvas(w, h);
      this[key] = c;
    }
    const ctx = c.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.filter = "none";
    ctx.clearRect(0, 0, w, h);
    return { canvas: c, ctx };
  }

  /* ---------------- render ---------------- */

  /** Live render to the visible canvas, at preview scale. */
  render() {
    if (!this.original) return;
    const scale = this.previewScale;
    const stage = this._stageFor(scale);
    if (this.display.width !== stage.width || this.display.height !== stage.height) {
      this.display.width = stage.width;
      this.display.height = stage.height;
    }
    this._composite(this.ctx, stage, { maskEdge: this.showMaskEdge });

    // The "before" half of the compare slider: the same stage's untouched
    // base, at the same pixel dimensions, so it overlays the display canvas
    // exactly with no separate scaling logic on the CSS side.
    if (this.beforeCanvas) {
      if (this.beforeCanvas.width !== stage.width || this.beforeCanvas.height !== stage.height) {
        this.beforeCanvas.width = stage.width;
        this.beforeCanvas.height = stage.height;
      }
      const bctx = this.beforeCanvas.getContext("2d");
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.clearRect(0, 0, stage.width, stage.height);
      bctx.drawImage(stage.base, 0, 0);
    }
  }

  /**
   * The whole compositing pass, spec §6.2. Note what is NOT here: any read of
   * the previous frame. Everything is derived from `stage`.
   */
  _composite(ctx, stage, { maskEdge = false } = {}) {
    const { width: w, height: h } = stage;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(stage.base, 0, 0);                    // untouched original underneath

    for (const layer of this.layers) {
      const clipped = stage.layers.get(layer.id);
      if (!clipped) continue;
      const { tint, tintStrength, hue, saturation, texture, textureStrength, textureRotation, textureDepth } = layer.edits;

      /* --- colour + saturation, inside the mask only --- */
      const { canvas: adjusted, ctx: actx } = this._scratchFor(1, w, h);
      actx.filter = `hue-rotate(${hue}deg) saturate(${saturation}%)`;
      actx.drawImage(clipped, 0, 0);                    // filter applies during the draw
      actx.filter = "none";

      if (tint && tintStrength > 0) {
        // "color" takes hue+saturation from the source and luminosity from
        // the backdrop, which is exactly what repainting a surface means:
        // new colour, same light. A flat fill would erase every shadow.
        // tintStrength rides on globalAlpha: at 1 the blend fully replaces
        // hue/saturation, and below that the original colour shows through
        // proportionally — a intensity control rather than an on/off switch.
        actx.globalAlpha = tintStrength;
        actx.globalCompositeOperation = "color";
        actx.fillStyle = tint;
        actx.fillRect(0, 0, w, h);
        actx.globalAlpha = 1;
        // The fill covered the whole frame; re-clip to the mask, because a
        // blend against transparent backdrop leaves the raw colour behind.
        actx.globalCompositeOperation = "destination-in";
        actx.drawImage(clipped, 0, 0);
        actx.globalCompositeOperation = "source-over";
      }

      ctx.drawImage(adjusted, 0, 0);
      // Slot 1 ("adjusted") is fully consumed as of the drawImage above —
      // free to reuse below, which _warpDepth does.

      /* --- texture --- */
      const tileCanvas = getTextureTile(texture);
      if (tileCanvas && textureStrength > 0) {
        const { canvas: raw, ctx: rctx } = this._scratchFor(3, w, h);
        const pattern = rctx.createPattern(tileCanvas, "repeat");
        // Scale the tile with the working resolution so the preview and the
        // full-res export show the same texture, not the same pixel count.
        // Rotation rides the same matrix so a tile can be turned to match a
        // wall's angle without a second transform pass.
        if (pattern.setTransform) {
          try {
            const m = new DOMMatrix();
            m.rotateSelf(textureRotation || 0);
            m.scaleSelf(stage.scale, stage.scale);
            pattern.setTransform(m);
          } catch { /* older engines: tile stays at 1:1, unrotated, still usable */ }
        }
        rctx.fillStyle = pattern;
        rctx.fillRect(0, 0, w, h);

        // Depth warps the tile fill itself, full-frame and unclipped — the
        // mask boundary is never part of this canvas, so it can't be
        // distorted by it. Clipping to the mask always happens after.
        const warped = textureDepth ? this._warpDepth(raw, w, h, textureDepth / 100) : raw;

        const { canvas: tex, ctx: tctx } = this._scratchFor(2, w, h);
        tctx.drawImage(warped, 0, 0);
        tctx.globalCompositeOperation = "destination-in";
        tctx.drawImage(clipped, 0, 0);                  // clip the tiling to the mask
        tctx.globalCompositeOperation = "source-over";

        ctx.globalAlpha = textureStrength;
        ctx.globalCompositeOperation = "multiply";      // keeps shading readable
        ctx.drawImage(tex, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
    }

    if (maskEdge) this._drawMaskEdge(ctx, stage);
  }

  /**
   * Compress the tile fill toward one edge to suggest depth — see
   * depthStripBoundaries() for the geometry. Draws into scratch slot 1,
   * which is safe to reuse here: by the time texture warping runs, this
   * layer's colour pass has already consumed slot 1 and drawn it out.
   *
   * @param {HTMLCanvasElement} source the flat, unwarped tile fill
   * @returns {HTMLCanvasElement} a new canvas — never mutates `source`,
   *          since strips are read from it while a different canvas is
   *          written to, avoiding self-overlap artefacts mid-loop.
   */
  _warpDepth(source, w, h, depth) {
    if (!depth) return source;
    const strips = 48;
    const boundaries = depthStripBoundaries(w, strips, depth);
    const { canvas: out, ctx: octx } = this._scratchFor(1, w, h);
    const srcStripW = w / strips;
    for (let i = 0; i < strips; i += 1) {
      const destX = boundaries[i];
      const destW = boundaries[i + 1] - destX;
      if (destW <= 0) continue;
      octx.drawImage(source, i * srcStripW, 0, srcStripW, h, destX, 0, destW, h);
    }
    return out;
  }

  /**
   * Outline every mask with a two-tone edge: a wide white halo under a
   * narrower accent-coloured line. A single thin accent line all but
   * vanished against green foliage, shadowed walls, or anything else close
   * to the accent's own hue — the halo guarantees contrast against both
   * light and dark, saturated and muted photo content, which is exactly
   * when knowing the mask's exact boundary matters most. Erosion by four
   * offset destination-out draws leaves a band at the boundary — cheap, and
   * it answers the question the user actually has ("did it get the whole
   * wall?").
   */
  _drawMaskEdge(ctx, stage) {
    const { width: w, height: h } = stage;
    const outerBand = Math.max(3, Math.round(Math.min(w, h) / 160));
    const innerBand = Math.max(1.5, Math.round(outerBand * 0.55));

    const erode = (ectx, mask, band, color) => {
      ectx.drawImage(mask, 0, 0, w, h);
      ectx.globalCompositeOperation = "destination-out";
      for (const [dx, dy] of [[band, 0], [-band, 0], [0, band], [0, -band]]) {
        ectx.drawImage(mask, dx, dy, w, h);
      }
      ectx.globalCompositeOperation = "source-in";
      ectx.fillStyle = color;
      ectx.fillRect(0, 0, w, h);
      ectx.globalCompositeOperation = "source-over";
    };

    for (const layer of this.layers) {
      const { canvas: halo, ctx: hctx } = this._scratchFor(2, w, h);
      erode(hctx, layer.mask, outerBand, "#ffffff");
      ctx.globalAlpha = 0.85;
      ctx.drawImage(halo, 0, 0);

      // Same scratch slot, reused sequentially — halo has already been
      // drawn out to ctx by this point, nothing left in it to lose.
      const { canvas: edge, ctx: ectx } = this._scratchFor(2, w, h);
      erode(ectx, layer.mask, innerBand, "#3f6b4a");
      ctx.globalAlpha = 1;
      ctx.drawImage(edge, 0, 0);
    }
  }

  /* ---------------- export ---------------- */

  /**
   * Full-resolution PNG, spec §6.3. Composited fresh at scale 1 rather than
   * upscaling the preview, so the download is the real thing and not a
   * blown-up 1200px proxy. The mask edge overlay is never exported — it is a
   * working aid, not part of the picture.
   */
  toBlob({ type = "image/png", quality } = {}) {
    if (!this.original) return Promise.reject(new Error("Nothing to export."));
    const stage = this._buildStage(1);
    const out = makeCanvas(stage.width, stage.height);
    this._composite(out.getContext("2d"), stage, { maskEdge: false });
    return new Promise((resolve, reject) => {
      out.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("The export could not be encoded."))),
        type,
        quality,
      );
    });
  }

  /** Drop cached stages; call before loading a different photo. */
  dispose() {
    this._stage = null;
    this._scratch = null;
    this._scratch2 = null;
    this._scratch3 = null;
    this.layers = [];
    this.original = null;
    if (this.beforeCanvas) {
      this.beforeCanvas.width = 1;
      this.beforeCanvas.height = 1;
    }
  }
}
