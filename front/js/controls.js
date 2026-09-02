/**
 * controls.js — the property panel.
 *
 * Owns the DOM of the editing controls and which layer they currently point
 * at. Every control listens on `input`, not `change`, so the canvas follows
 * the thumb while it is moving; renders are collapsed to one per animation
 * frame, because a slider drag fires far faster than the screen refreshes and
 * rendering the frames nobody sees is pure heat.
 *
 * The surfaces list (renderSurfaceList) is always visible, even with a single
 * surface, and lives above the colour/texture controls and above Download —
 * creating and choosing a surface is one glance up, not a hunt. Each row
 * carries its own reorder buttons; the compositor draws layers back-to-front
 * in array order, so moving a row up or down is a real change in which
 * surface paints over which.
 */

import { CONFIG } from "./config.js";
import { t } from "./i18n.js";
import { TEXTURES, getTextureTile, defaultEdits } from "./compositor.js";

const $ = (id) => document.getElementById(id);

export function createControls({ compositor, onEdit = () => {}, onHistoryChange = () => {} }) {
  const el = {
    swatches: $("swatches"),
    tint: $("tint"),
    tintOff: $("tintOff"),
    tintReadout: $("tintReadout"),
    tintStrength: $("tintStrength"),
    tintStrengthReadout: $("tintStrengthReadout"),
    specular: $("specular"),
    specularReadout: $("specularReadout"),
    hue: $("hue"),
    hueReadout: $("hueReadout"),
    sat: $("sat"),
    satReadout: $("satReadout"),
    textures: $("textures"),
    texReadout: $("texReadout"),
    texStrength: $("texStrength"),
    texStrengthReadout: $("texStrengthReadout"),
    texRotation: $("texRotation"),
    texRotationReadout: $("texRotationReadout"),
    texDepth: $("texDepth"),
    texDepthReadout: $("texDepthReadout"),
    feather: $("feather"),
    featherReadout: $("featherReadout"),
    growShrink: $("growShrink"),
    growShrinkReadout: $("growShrinkReadout"),
    showMask: $("showMask"),
    resetEdits: $("resetEdits"),
    surfaceList: $("surfaceList"),
  };

  let activeId = null;
  let frame = 0;

  /* --------------------- history (undo/redo) ---------------------
     A snapshot is the edits AND the mask of every layer, plus which one was
     active — restoring one puts the whole panel back exactly as it was, not
     just the control that changed. The edits half is genuinely free (small
     plain objects); the mask half stays cheap too, because it's a
     *reference*, not a clone — brush.js hands each stroke a brand new mask
     canvas rather than painting into the old one in place (the same
     never-mutate contract layer.edits already follows for a colour/texture
     patch), so an earlier snapshot's mask reference simply keeps pointing at
     whatever canvas was current when it was taken. Deliberately unbounded:
     "unlimited" undo is just... not capping it.
     Pushed at *settle* points (a slider's `change`, a button's `click`, a
     brush stroke's pointerup) — never on `input`/pointermove — so dragging a
     slider (or a brush) across its whole range is one history entry, not one
     per tick of movement. */
  let history = [];
  let historyIndex = -1;

  function snapshot() {
    return {
      activeId,
      layers: compositor.layers.map((l) => ({ id: l.id, edits: { ...l.edits }, mask: l.mask })),
    };
  }

  function notifyHistory() {
    onHistoryChange({ canUndo: historyIndex > 0, canRedo: historyIndex < history.length - 1 });
  }

  /** Call after any settled change to the active layer — an edits patch or
   *  a committed brush stroke. A no-op with nothing to snapshot yet. */
  function pushHistory() {
    if (!compositor.layers.length) return;
    // A new action after undoing some steps discards the abandoned redo
    // branch — standard undo/redo semantics, not a stack of alternates.
    history = history.slice(0, historyIndex + 1);
    history.push(snapshot());
    historyIndex = history.length - 1;
    notifyHistory();
  }

  function applySnapshot(snap) {
    for (const { id, edits, mask } of snap.layers) {
      compositor.setEdits(id, edits);
      if (mask && compositor.getLayer(id)?.mask !== mask) {
        compositor.updateLayerSource(id, { mask });
      }
    }
    if (snap.activeId && compositor.getLayer(snap.activeId)) {
      setActiveLayer(snap.activeId);
    } else {
      renderSurfaceList();
      const layer = compositor.getLayer(activeId);
      if (layer) syncReadouts(layer.edits);
    }
    schedule();
  }

  function undo() {
    if (historyIndex <= 0) return;
    historyIndex -= 1;
    applySnapshot(history[historyIndex]);
    notifyHistory();
  }

  function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex += 1;
    applySnapshot(history[historyIndex]);
    notifyHistory();
  }

  /* --------------------- render scheduling --------------------- */

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      compositor.render();
    });
  }

  function commit(patch) {
    if (!activeId) return;
    const edits = compositor.setEdits(activeId, patch);
    syncReadouts(edits);
    schedule();
    onEdit(activeId, edits);
    renderSurfaceList();
  }

  /* --------------------- one-time DOM building --------------------- */

  function buildSwatches() {
    el.swatches.innerHTML = "";
    for (const preset of CONFIG.COLOR_PRESETS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "swatch";
      button.style.background = preset.hex;
      button.title = `${preset.name} ${preset.hex}`;
      button.setAttribute("aria-label", preset.name);
      button.setAttribute("aria-pressed", "false");
      button.dataset.hex = preset.hex;
      button.addEventListener("click", () => {
        el.tint.value = preset.hex;
        // Picking a swatch is a colour decision, not an intensity one — if
        // the person had dialled intensity to zero on a previous colour,
        // silently keeping it there would make the new swatch look like it
        // didn't apply. Only correct that when it's actually at zero.
        const patch = { tint: preset.hex };
        if (compositor.getLayer(activeId)?.edits.tintStrength === 0) patch.tintStrength = 1;
        commit(patch);
        pushHistory();
      });
      el.swatches.append(button);
    }
  }

  function buildTextures() {
    el.textures.innerHTML = "";
    for (const texture of TEXTURES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "texture";
      button.dataset.texture = texture.id;
      button.setAttribute("aria-pressed", String(texture.id === "none"));

      const tile = getTextureTile(texture.id);
      if (tile) {
        // The button preview is the identical tile the canvas will use.
        button.style.backgroundImage = `url(${tile.toDataURL("image/png")})`;
        button.style.backgroundRepeat = "repeat";
        button.style.backgroundSize = "46px 46px";
      } else {
        button.style.background =
          "repeating-linear-gradient(45deg,#fff 0 6px,#f0efeb 6px 12px)";
      }

      const label = document.createElement("span");
      label.textContent = texture.label;
      button.append(label);

      button.addEventListener("click", () => { commit({ texture: texture.id }); pushHistory(); });
      el.textures.append(button);
    }
  }

  /* --------------------- readouts --------------------- */

  function syncReadouts(edits) {
    el.hue.value = String(edits.hue);
    el.hueReadout.value = String(edits.hue);

    el.sat.value = String(edits.saturation);
    el.satReadout.value = String(edits.saturation);

    el.texStrength.value = String(Math.round(edits.textureStrength * 100));
    el.texStrengthReadout.value = String(Math.round(edits.textureStrength * 100));

    el.texRotation.value = String(edits.textureRotation);
    el.texRotationReadout.value = String(edits.textureRotation);
    el.texDepth.value = String(edits.textureDepth);
    el.texDepthReadout.value = String(edits.textureDepth);
    // Rotating or depth-warping a texture that isn't applied has nothing to
    // show — disabled rather than hidden, so the controls don't jump around
    // as textures are picked and cleared.
    el.texRotation.disabled = edits.texture === "none";
    el.texDepth.disabled = edits.texture === "none";
    el.texRotationReadout.disabled = edits.texture === "none";
    el.texDepthReadout.disabled = edits.texture === "none";

    el.feather.value = String(edits.feather);
    el.featherReadout.value = String(edits.feather);

    el.growShrink.value = String(edits.growShrink);
    el.growShrinkReadout.value = String(edits.growShrink);

    el.tintStrength.value = String(Math.round(edits.tintStrength * 100));
    el.tintStrengthReadout.value = String(Math.round(edits.tintStrength * 100));
    el.tintStrength.disabled = !edits.tint;
    el.tintStrengthReadout.disabled = !edits.tint;

    for (const input of document.querySelectorAll('input[name="blendMode"]')) {
      input.checked = input.value === (edits.blendMode || "normal");
    }

    el.specular.value = String(edits.specular);
    el.specularReadout.value = String(edits.specular);


    el.texReadout.textContent = edits.texture;
    for (const button of el.textures.querySelectorAll(".texture")) {
      button.setAttribute("aria-pressed", String(button.dataset.texture === edits.texture));
    }

    if (edits.tint) {
      el.tint.value = edits.tint;
      const preset = CONFIG.COLOR_PRESETS.find(
        (p) => p.hex.toLowerCase() === edits.tint.toLowerCase(),
      );
      el.tintReadout.textContent = preset ? `${preset.name} ${edits.tint}` : edits.tint;
    } else {
      el.tintReadout.textContent = t("edit.colorOffReadout");
    }

    for (const button of el.swatches.querySelectorAll(".swatch")) {
      const on = Boolean(edits.tint) && button.dataset.hex.toLowerCase() === edits.tint.toLowerCase();
      button.setAttribute("aria-pressed", String(on));
    }

    el.tintOff.hidden = !edits.tint;
  }

  /* --------------------- surfaces list (create, choose, reorder) --------------------- */

  function renderSurfaceList() {
    const layers = compositor.layers;
    el.surfaceList.innerHTML = "";

    layers.forEach((layer, index) => {
      const row = document.createElement("li");
      row.className = "surfacerow";

      const select = document.createElement("button");
      select.type = "button";
      select.className = "surfacerow__select";
      select.setAttribute("aria-pressed", String(layer.id === activeId));

      const dot = document.createElement("span");
      dot.className = "swatchdot";
      dot.style.background = layer.edits.tint || "transparent";
      dot.style.borderStyle = layer.edits.tint ? "solid" : "dashed";

      const name = document.createElement("span");
      name.className = "surfacerow__name";
      name.textContent = layer.label;

      select.append(dot, name);
      select.addEventListener("click", () => setActiveLayer(layer.id));

      const actions = document.createElement("div");
      actions.className = "surfacerow__actions";

      const up = document.createElement("button");
      up.type = "button";
      up.className = "iconbtn";
      up.setAttribute("aria-label", t("edit.moveUpAria", { label: layer.label }));
      up.title = t("edit.moveUp");
      up.textContent = "▲";
      up.disabled = index === 0;
      up.addEventListener("click", (event) => {
        event.stopPropagation();
        if (compositor.moveLayer(layer.id, -1)) {
          schedule();
          renderSurfaceList();
        }
      });

      const down = document.createElement("button");
      down.type = "button";
      down.className = "iconbtn";
      down.setAttribute("aria-label", t("edit.moveDownAria", { label: layer.label }));
      down.title = t("edit.moveDown");
      down.textContent = "▼";
      down.disabled = index === layers.length - 1;
      down.addEventListener("click", (event) => {
        event.stopPropagation();
        if (compositor.moveLayer(layer.id, 1)) {
          schedule();
          renderSurfaceList();
        }
      });

      actions.append(up, down);
      row.append(select, actions);
      el.surfaceList.append(row);
    });
  }

  /* --------------------- public surface --------------------- */

  function setActiveLayer(id) {
    activeId = id;
    const layer = compositor.getLayer(id);
    if (layer) syncReadouts(layer.edits);
    renderSurfaceList();
  }

  function refresh() {
    renderSurfaceList();
    const layer = compositor.getLayer(activeId) ?? compositor.layers.at(-1) ?? null;
    if (layer) {
      activeId = layer.id;
      syncReadouts(layer.edits);
    }
    if (history.length === 0 && compositor.layers.length > 0) pushHistory();
    schedule();
  }

  /* --------------------- listeners --------------------- */

  /** Wires a numeric text field to mirror and drive the same range slider —
   *  a value can be typed directly (Enter or blur commits it) instead of
   *  only dragged. `toEdit` converts the field's raw number into whatever
   *  commit() expects (tintStrength/textureStrength store 0…1, not 0…100,
   *  for instance). Out-of-range typed values clamp to the slider's own
   *  min/max rather than silently doing nothing. */
  function linkNumberField(field, slider, toEdit) {
    const clamp = (n) => Math.min(Number(slider.max), Math.max(Number(slider.min), n));
    const apply = () => {
      const n = Number(field.value);
      if (Number.isNaN(n)) { field.value = slider.value; return; }
      const clamped = clamp(n);
      // "change" and Enter's keydown can both fire for one edit (typing a
      // value then pressing Enter triggers both) — without this, that's
      // two history entries for what the person did once.
      if (clamped === Number(slider.value)) { field.value = String(clamped); return; }
      field.value = String(clamped);
      slider.value = String(clamped);
      commit(toEdit(clamped));
      pushHistory();
    };
    field.addEventListener("change", apply);
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { apply(); field.blur(); }
    });
  }

  el.hue.addEventListener("input", () => commit({ hue: Number(el.hue.value) }));
  el.hue.addEventListener("change", pushHistory);
  linkNumberField(el.hueReadout, el.hue, (n) => ({ hue: n }));
  el.sat.addEventListener("input", () => commit({ saturation: Number(el.sat.value) }));
  el.sat.addEventListener("change", pushHistory);
  linkNumberField(el.satReadout, el.sat, (n) => ({ saturation: n }));
  el.tint.addEventListener("input", () => {
    const patch = { tint: el.tint.value };
    // Same reasoning as the swatch handler: dragging the colour wheel while
    // intensity sits at zero should produce a visible result, not silence.
    if (compositor.getLayer(activeId)?.edits.tintStrength === 0) patch.tintStrength = 1;
    commit(patch);
  });
  el.tint.addEventListener("change", pushHistory);
  el.tintOff.addEventListener("click", () => { commit({ tint: null }); pushHistory(); });
  el.tintStrength.addEventListener("input", () =>
    commit({ tintStrength: Number(el.tintStrength.value) / 100 }));
  el.tintStrength.addEventListener("change", pushHistory);
  linkNumberField(el.tintStrengthReadout, el.tintStrength, (n) => ({ tintStrength: n / 100 }));

  for (const input of document.querySelectorAll('input[name="blendMode"]')) {
    input.addEventListener("change", () => {
      if (input.checked) { commit({ blendMode: input.value }); pushHistory(); }
    });
  }

  el.specular.addEventListener("input", () => commit({ specular: Number(el.specular.value) }));
  el.specular.addEventListener("change", pushHistory);
  linkNumberField(el.specularReadout, el.specular, (n) => ({ specular: n }));

  el.texStrength.addEventListener("input", () =>
    commit({ textureStrength: Number(el.texStrength.value) / 100 }));
  el.texStrength.addEventListener("change", pushHistory);
  linkNumberField(el.texStrengthReadout, el.texStrength, (n) => ({ textureStrength: n / 100 }));
  el.texRotation.addEventListener("input", () =>
    commit({ textureRotation: Number(el.texRotation.value) }));
  el.texRotation.addEventListener("change", pushHistory);
  linkNumberField(el.texRotationReadout, el.texRotation, (n) => ({ textureRotation: n }));
  el.texDepth.addEventListener("input", () =>
    commit({ textureDepth: Number(el.texDepth.value) }));
  el.texDepth.addEventListener("change", pushHistory);
  linkNumberField(el.texDepthReadout, el.texDepth, (n) => ({ textureDepth: n }));

  el.growShrink.addEventListener("input", () => commit({ growShrink: Number(el.growShrink.value) }));
  el.growShrink.addEventListener("change", pushHistory);
  linkNumberField(el.growShrinkReadout, el.growShrink, (n) => ({ growShrink: n }));

  el.feather.addEventListener("input", () => commit({ feather: Number(el.feather.value) }));
  el.feather.addEventListener("change", pushHistory);
  linkNumberField(el.featherReadout, el.feather, (n) => ({ feather: n }));

  el.showMask.addEventListener("change", () => {
    compositor.showMaskEdge = el.showMask.checked;
    schedule();
  });

  el.resetEdits.addEventListener("click", () => {
    if (!activeId) return;
    compositor.setEdits(activeId, defaultEdits());
    syncReadouts(compositor.getLayer(activeId).edits);
    schedule();
    renderSurfaceList();
    pushHistory();
  });

  buildSwatches();
  buildTextures();
  syncReadouts(defaultEdits());

  return {
    setActiveLayer,
    refresh,
    schedule,
    undo,
    redo,
    /** Public entry point for anything outside this module that just made a
     *  settled change to the active layer — currently only brush.js, after
     *  a stroke commits. */
    commitHistoryCheckpoint: pushHistory,
    get activeId() { return activeId; },
    /** Called when the photo is replaced: back to a clean panel. */
    resetPanel() {
      activeId = null;
      compositor.showMaskEdge = false;
      el.showMask.checked = false;
      el.surfaceList.innerHTML = "";
      syncReadouts(defaultEdits());
      history = [];
      historyIndex = -1;
      notifyHistory();
    },
  };
}
