// editcache.js — keeps a layer's edited mask and its edits (colour,
// texture, Feather, Grow/Shrink, Blend Mode, Specular, Perspective Warp —
// everything in layer.edits, plus the mask canvas itself) in this browser's
// IndexedDB, keyed by the layer's own id.
//
// This exists because there is currently no server-side place for any of
// this to live: resuming a session brings back the *original* segmentation
// or label map, never what happened in the editor afterward. See
// docs/edits-persistence-contract.md for the real fix — a backend endpoint,
// synced across devices. This module is deliberately shaped to match that
// same contract (`{ edits, mask }`) so upgrading later is additive: try the
// server, fall back to this. Until then, this is same-device-only and can
// be lost if the person clears site data — worth saying once, out loud,
// rather than implying a guarantee this doesn't make.
//
// Every export is best-effort: IndexedDB can be unavailable (private
// browsing in some browsers, a corrupted database) or a write/read can
// simply fail, and none of that should ever be allowed to interrupt
// editing. Every function below swallows its own errors and degrades to
// "nothing was cached" rather than throwing into caller code that was never
// written to expect this to fail.

const DB_NAME = "maskwork-editcache";
const DB_VERSION = 1;
const STORE = "layers";

function openDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) { reject(new Error("IndexedDB unavailable")); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "layerId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("mask encode failed"))), "image/png");
  });
}

function blobToCanvas(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      URL.revokeObjectURL(img.src);
      resolve(canvas);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

/** Saves one layer's current mask + edits under its own id, replacing
 *  whatever was cached for that id before. Silently does nothing on
 *  failure — see the file header. */
export async function saveLayer(layer) {
  try {
    const maskBlob = await canvasToBlob(layer.mask);
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({
        layerId: layer.id,
        label: layer.label,
        edits: layer.edits,
        maskBlob,
        savedAt: Date.now(),
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Best-effort — see file header.
  }
}

/** Saves several layers in one go — the usual call shape, since a settled
 *  edit is saved for the whole surface list, not just the layer that
 *  changed (undo/redo can move every layer's edits at once). */
export async function saveLayers(layers) {
  await Promise.all(layers.map((layer) => saveLayer(layer)));
}

/** Returns { mask: <canvas>, edits } for a previously cached layer id, or
 *  null if nothing's cached for it (or the cache can't be read at all). */
export async function loadLayer(layerId) {
  try {
    const db = await openDb();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(layerId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!record) return null;
    const mask = await blobToCanvas(record.maskBlob);
    return { mask, edits: record.edits };
  } catch {
    return null;
  }
}

/** Drops the cached entry for one layer id — call when a surface is
 *  deleted, so a later id collision (unlikely, but ids can be reused
 *  across a reset draft) never resurrects an unrelated edit. */
export async function clearLayer(layerId) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(layerId);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Best-effort — see file header.
  }
}
