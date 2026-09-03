// warp.js — the Perspective Warp control-point grid: dragging handles,
// and growing/shrinking the grid itself (Add/Remove row/column).
//
// Standalone like brush.js/ui/theme.js/etc: reads/writes only the active
// layer's edits.warpPoints/warpRows/warpCols (via compositor.setEdits, the
// same funnel every other control uses) and the DOM it owns outright (the
// SVG mesh, the handle buttons — created and destroyed here as the grid
// size changes, since a fixed HTML markup can't declare "however many
// handles the grid currently needs"). It doesn't know about tabs — app.js
// decides when to call setVisible(), same relationship it has with
// brush.js and Mask-tab activity.
//
// Coordinate model matches brush.js: every pointer position is read as a
// FRACTION of the display canvas's own rendered box, which already accounts
// for the current zoom transform, so nothing here needs to know the zoom
// level. warpPoints are stored as those same 0..1 fractions, row-major
// (index = row*cols + col) — see compositor.js's identityWarpGrid and
// _warpPerspective, which expect exactly that layout.

import { identityWarpGrid } from "../compositor.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_SIZE = 2;
const MAX_SIZE = 5;

/** Inserts a new row/column of points, linearly interpolated between the
 *  two it ends up sitting between — preserves whatever shape is already
 *  there instead of resetting it, so adding more control doesn't throw away
 *  work already done. Always inserts roughly in the middle (not at an
 *  edge), which needs no special-casing for "where" the way an edge
 *  insertion would (there's always a "before" and "after" to average). */
function insertRow(points, rows, cols) {
  const at = Math.ceil(rows / 2);
  const above = points.slice((at - 1) * cols, at * cols);
  const below = points.slice(at * cols, (at + 1) * cols);
  const mid = above.map(([x1, y1], c) => {
    const [x2, y2] = below[c];
    return [(x1 + x2) / 2, (y1 + y2) / 2];
  });
  return [...points.slice(0, at * cols), ...mid, ...points.slice(at * cols)];
}

function insertColumn(points, rows, cols) {
  const at = Math.ceil(cols / 2);
  const out = [];
  for (let r = 0; r < rows; r += 1) {
    const row = points.slice(r * cols, (r + 1) * cols);
    const [x1, y1] = row[at - 1];
    const [x2, y2] = row[at];
    const mid = [(x1 + x2) / 2, (y1 + y2) / 2];
    out.push(...row.slice(0, at), mid, ...row.slice(at));
  }
  return out;
}

/** Removes a middle-ish row/column (never an edge one — losing an interior
 *  seam is much less disruptive to the shape than losing a corner). */
function removeRow(points, rows, cols) {
  const at = Math.floor(rows / 2);
  return [...points.slice(0, at * cols), ...points.slice((at + 1) * cols)];
}

function removeColumn(points, rows, cols) {
  const at = Math.floor(cols / 2);
  const out = [];
  for (let r = 0; r < rows; r += 1) {
    const row = points.slice(r * cols, (r + 1) * cols);
    out.push(...row.slice(0, at), ...row.slice(at + 1));
  }
  return out;
}

export function createWarpTool({
  compositor,
  getActiveLayerId,
  displayCanvas,
  overlaySvg,
  meshGroup,
  handlesContainer,
  rowsReadout,
  colsReadout,
  onPointsCommitted = () => {},
}) {
  let dragIndex = null;

  function activeLayer() {
    const id = getActiveLayerId();
    return id ? compositor.getLayer(id) : null;
  }

  function gridOf(layer) {
    const rows = layer?.edits.warpRows || 2;
    const cols = layer?.edits.warpCols || 2;
    const points = Array.isArray(layer?.edits.warpPoints) && layer.edits.warpPoints.length === rows * cols
      ? layer.edits.warpPoints
      : identityWarpGrid(rows, cols);
    return { rows, cols, points };
  }

  /** Rebuilds the mesh (cell fills + grid lines) and reconciles the handle
   *  button count with however many points the grid currently has, rather
   *  than assuming it's always 4 — grown or shrunk since the last render,
   *  both directions are just "however many children the container needs
   *  now", added or removed at the end. */
  function render() {
    const { rows, cols, points } = gridOf(activeLayer());
    if (rowsReadout) rowsReadout.textContent = String(rows);
    if (colsReadout) colsReadout.textContent = String(cols);

    meshGroup.innerHTML = "";
    for (let r = 0; r < rows - 1; r += 1) {
      for (let c = 0; c < cols - 1; c += 1) {
        const p00 = points[r * cols + c];
        const p10 = points[r * cols + c + 1];
        const p11 = points[(r + 1) * cols + c + 1];
        const p01 = points[(r + 1) * cols + c];
        const cell = document.createElementNS(SVG_NS, "polygon");
        cell.setAttribute("class", "warpoverlay__cell");
        cell.setAttribute("points", [p00, p10, p11, p01].map((p) => p.join(",")).join(" "));
        meshGroup.appendChild(cell);
      }
    }
    for (let r = 0; r < rows; r += 1) {
      const row = points.slice(r * cols, (r + 1) * cols);
      const line = document.createElementNS(SVG_NS, "polyline");
      line.setAttribute("class", "warpoverlay__line");
      line.setAttribute("points", row.map((p) => p.join(",")).join(" "));
      meshGroup.appendChild(line);
    }
    for (let c = 0; c < cols; c += 1) {
      const col = [];
      for (let r = 0; r < rows; r += 1) col.push(points[r * cols + c]);
      const line = document.createElementNS(SVG_NS, "polyline");
      line.setAttribute("class", "warpoverlay__line");
      line.setAttribute("points", col.map((p) => p.join(",")).join(" "));
      meshGroup.appendChild(line);
    }

    const needed = rows * cols;
    while (handlesContainer.children.length < needed) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "warphandle";
      btn.addEventListener("pointerdown", pointerDown);
      handlesContainer.appendChild(btn);
    }
    while (handlesContainer.children.length > needed) {
      handlesContainer.lastChild.remove();
    }
    [...handlesContainer.children].forEach((btn, i) => {
      btn.dataset.warpIndex = String(i);
      btn.style.left = `${points[i][0] * 100}%`;
      btn.style.top = `${points[i][1] * 100}%`;
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
    const { rows, cols, points } = gridOf(layer);
    const next = points.map((p) => [...p]);
    // A generous clamp, not a tight one — dragging a handle well outside the
    // frame is a legitimate way to push a texture into a steep, dramatic
    // angle. Just stop short of letting the mesh fold back on itself.
    next[dragIndex] = [
      Math.max(-0.6, Math.min(1.6, frac.fx)),
      Math.max(-0.6, Math.min(1.6, frac.fy)),
    ];
    compositor.setEdits(id, { warpRows: rows, warpCols: cols, warpPoints: next });
    compositor.render();
    render();
  }

  function pointerUp() {
    if (dragIndex === null) return;
    dragIndex = null;
    onPointsCommitted();
  }

  document.addEventListener("pointermove", pointerMove);
  document.addEventListener("pointerup", pointerUp);
  document.addEventListener("pointercancel", pointerUp);

  /** Grows or shrinks the grid by one row/column, applying `transform` to
   *  get the new point list, clamped to [MIN_SIZE, MAX_SIZE] per side —
   *  below MIN_SIZE there's nothing left to remove (2×2 is the plain
   *  4-corner case), above MAX_SIZE the mesh gets fussy to drag on a phone
   *  screen without buying much real control beyond that. */
  function resize(dimension, transform, limit) {
    const id = getActiveLayerId();
    const layer = id ? compositor.getLayer(id) : null;
    if (!layer) return;
    const { rows, cols, points } = gridOf(layer);
    const current = dimension === "rows" ? rows : cols;
    const next = limit(current);
    if (next === current) return;
    const nextPoints = transform(points, rows, cols);
    const patch = dimension === "rows"
      ? { warpRows: next, warpCols: cols, warpPoints: nextPoints }
      : { warpRows: rows, warpCols: next, warpPoints: nextPoints };
    compositor.setEdits(id, patch);
    compositor.render();
    render();
    onPointsCommitted();
  }

  return {
    render,
    setVisible(visible) {
      overlaySvg.hidden = !visible;
      handlesContainer.hidden = !visible;
      if (visible) render();
    },
    reset() {
      const id = getActiveLayerId();
      const layer = id ? compositor.getLayer(id) : null;
      if (!layer) return;
      const { rows, cols } = gridOf(layer);
      compositor.setEdits(id, { warpRows: rows, warpCols: cols, warpPoints: identityWarpGrid(rows, cols) });
      compositor.render();
      render();
      onPointsCommitted();
    },
    addRow() { resize("rows", insertRow, (n) => Math.min(MAX_SIZE, n + 1)); },
    removeRow() { resize("rows", removeRow, (n) => Math.max(MIN_SIZE, n - 1)); },
    addColumn() { resize("cols", insertColumn, (n) => Math.min(MAX_SIZE, n + 1)); },
    removeColumn() { resize("cols", removeColumn, (n) => Math.max(MIN_SIZE, n - 1)); },
  };
}
