"""
SAM "everything" segmentation - splits an image into regions without any
semantic knowledge (doesn't know what a "wall" or "roof" is), based purely
on visual boundaries (edges, shadows, texture/color changes).

Intended for frontends that let the user manually pick which regions belong
together (e.g. click-to-select a wall, excluding a roof that a semantic
model can't reliably separate on its own). Returns a "label map": a
grayscale image where each pixel's value is the id of the region it belongs
to (0 = unassigned).
"""
import os
import numpy as np
from PIL import Image

SAM_MODEL_ID = os.environ.get("SAM_MODEL_ID", "facebook/sam-vit-base")
POINTS_PER_BATCH = int(os.environ.get("SAM_POINTS_PER_BATCH", "32"))
# SAM's default confidence thresholds (0.88 / 0.95) reject large, flat,
# uniformly-colored surfaces (e.g. a plain wall) because they give a weaker
# confidence signal than textured objects. Lowered here to capture them too.
PRED_IOU_THRESH = float(os.environ.get("SAM_PRED_IOU_THRESH", "0.75"))
STABILITY_SCORE_THRESH = float(os.environ.get("SAM_STABILITY_SCORE_THRESH", "0.85"))
# Total sampled points = POINTS_PER_SIDE^2 — this is the dominant cost driver for SAM's
# automatic mask generator, since the mask decoder runs once per point. Left unset, the
# pipeline's own default (32, i.e. 1024 points) applies. Lowered by default here: the ViT
# image encoder itself resizes to a fixed working resolution internally regardless of what we
# send it, so encoder cost is roughly constant — the real, controllable lever is how many
# points get decoded, not image size. See the sidecar README's "why is /regions slow" note.
POINTS_PER_SIDE = int(os.environ.get("SAM_POINTS_PER_SIDE", "16"))
# Multi-scale image cropping (in addition to the full image) can help catch
# both large and small regions - however it currently triggers a shape
# mismatch bug in transformers' SAM crop generation for non-square images,
# so it stays disabled (0) by default. Enable at your own risk.
CROPS_N_LAYERS = int(os.environ.get("SAM_CROPS_N_LAYERS", "0"))
# An 8-bit PNG (mode "L") can hold values 0-255; 0 is reserved for
# "unassigned", leaving 254 usable region ids.
MAX_SEGMENTS = 254

_state: dict = {}


def _load():
    if "generator" in _state:
        return _state
    from transformers import pipeline
    generator = pipeline("mask-generation", model=SAM_MODEL_ID, device=-1)
    _state["generator"] = generator
    return _state


def get_label_map(image: Image.Image) -> np.ndarray:
    """Returns a (H, W) uint8 array - 0 = unassigned, 1..N = region id."""
    st = _load()
    orig_w, orig_h = image.size

    outputs = st["generator"](
        image,
        points_per_batch=POINTS_PER_BATCH,
        points_per_side=POINTS_PER_SIDE,
        pred_iou_thresh=PRED_IOU_THRESH,
        stability_score_thresh=STABILITY_SCORE_THRESH,
        crops_n_layers=CROPS_N_LAYERS,
    )
    sam_masks = outputs["masks"]

    masks_with_area = []
    for seg in sam_masks:
        seg_bool = np.asarray(seg).astype(bool)
        if seg_bool.shape != (orig_h, orig_w):
            continue
        area = int(seg_bool.sum())
        if area == 0:
            continue
        masks_with_area.append((area, seg_bool))

    # Larger regions are painted FIRST (as a base layer), smaller/more
    # precise ones are painted OVER them - so fine details (e.g. a window
    # within a wall) stay individually selectable instead of being
    # overwritten by a large region.
    masks_with_area.sort(key=lambda t: t[0], reverse=True)

    label_map = np.zeros((orig_h, orig_w), dtype=np.uint8)
    next_id = 1
    for area, seg_bool in masks_with_area:
        if next_id > MAX_SEGMENTS:
            break
        label_map[seg_bool] = next_id
        next_id += 1

    # Safety net: even with lowered thresholds, some regions can remain
    # unassigned (id=0). Give them their own ids (grouped by connected
    # component) so every part of the image stays clickable on the frontend,
    # instead of permanently being a "dead zone" with no id.
    if next_id <= MAX_SEGMENTS:
        try:
            from scipy import ndimage
            unassigned = label_map == 0
            labeled_gaps, num_gaps = ndimage.label(unassigned)
            gap_sizes = ndimage.sum(unassigned, labeled_gaps, range(1, num_gaps + 1))
            gap_order = np.argsort(gap_sizes)[::-1]  # largest gap first
            for gap_idx in gap_order:
                if next_id > MAX_SEGMENTS:
                    break
                gap_label = gap_idx + 1
                label_map[labeled_gaps == gap_label] = next_id
                next_id += 1
        except ImportError:
            pass  # scipy not installed - gaps remain id=0 (still fine, just not clickable)

    return label_map
