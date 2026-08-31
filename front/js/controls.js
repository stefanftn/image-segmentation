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
import { TEXTURES, getTextureTile, defaultEdits } from "./compositor.js";

const $ = (id) => document.getElementById(id);

export function createControls({ compositor, onEdit = () => {} }) {
  const el = {
    swatches: $("swatches"),
    tint: $("tint"),
    tintOff: $("tintOff"),
    tintReadout: $("tintReadout"),
    tintStrength: $("tintStrength"),
    tintStrengthReadout: $("tintStrengthReadout"),
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
    showMask: $("showMask"),
    resetEdits: $("resetEdits"),
    surfaceList: $("surfaceList"),
  };

  let activeId = null;
  let frame = 0;

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

      button.addEventListener("click", () => commit({ texture: texture.id }));
      el.textures.append(button);
    }
  }

  /* --------------------- readouts --------------------- */

  function syncReadouts(edits) {
    el.hue.value = String(edits.hue);
    el.hueReadout.textContent = `${edits.hue > 0 ? "+" : ""}${edits.hue}°`;

    el.sat.value = String(edits.saturation);
    el.satReadout.textContent = `${edits.saturation}%`;

    el.texStrength.value = String(Math.round(edits.textureStrength * 100));
    el.texStrengthReadout.textContent = `${Math.round(edits.textureStrength * 100)}%`;

    el.texRotation.value = String(edits.textureRotation);
    el.texRotationReadout.textContent = `${edits.textureRotation > 0 ? "+" : ""}${edits.textureRotation}°`;
    el.texDepth.value = String(edits.textureDepth);
    el.texDepthReadout.textContent = `${edits.textureDepth > 0 ? "+" : ""}${edits.textureDepth}`;
    // Rotating or depth-warping a texture that isn't applied has nothing to
    // show — disabled rather than hidden, so the controls don't jump around
    // as textures are picked and cleared.
    el.texRotation.disabled = edits.texture === "none";
    el.texDepth.disabled = edits.texture === "none";

    el.tintStrength.value = String(Math.round(edits.tintStrength * 100));
    el.tintStrengthReadout.textContent = `${Math.round(edits.tintStrength * 100)}%`;
    el.tintStrength.disabled = !edits.tint;

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
      el.tintReadout.textContent = "off";
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
      up.setAttribute("aria-label", `Move ${layer.label} up`);
      up.title = "Move up";
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
      down.setAttribute("aria-label", `Move ${layer.label} down`);
      down.title = "Move down";
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
    schedule();
  }

  /* --------------------- listeners --------------------- */

  el.hue.addEventListener("input", () => commit({ hue: Number(el.hue.value) }));
  el.sat.addEventListener("input", () => commit({ saturation: Number(el.sat.value) }));
  el.tint.addEventListener("input", () => {
    const patch = { tint: el.tint.value };
    // Same reasoning as the swatch handler: dragging the colour wheel while
    // intensity sits at zero should produce a visible result, not silence.
    if (compositor.getLayer(activeId)?.edits.tintStrength === 0) patch.tintStrength = 1;
    commit(patch);
  });
  el.tintOff.addEventListener("click", () => commit({ tint: null }));
  el.tintStrength.addEventListener("input", () =>
    commit({ tintStrength: Number(el.tintStrength.value) / 100 }));

  el.texStrength.addEventListener("input", () =>
    commit({ textureStrength: Number(el.texStrength.value) / 100 }));
  el.texRotation.addEventListener("input", () =>
    commit({ textureRotation: Number(el.texRotation.value) }));
  el.texDepth.addEventListener("input", () =>
    commit({ textureDepth: Number(el.texDepth.value) }));

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
  });

  buildSwatches();
  buildTextures();
  syncReadouts(defaultEdits());

  return {
    setActiveLayer,
    refresh,
    schedule,
    get activeId() { return activeId; },
    /** Called when the photo is replaced: back to a clean panel. */
    resetPanel() {
      activeId = null;
      compositor.showMaskEdge = false;
      el.showMask.checked = false;
      el.surfaceList.innerHTML = "";
      syncReadouts(defaultEdits());
    },
  };
}
