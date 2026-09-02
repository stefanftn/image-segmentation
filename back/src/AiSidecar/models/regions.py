import os
import numpy as np
import torch
from PIL import Image

MOBILE_SAM_CHECKPOINT = os.environ.get("MOBILE_SAM_CHECKPOINT", "/app/mobile_sam.pt")
POINTS_PER_BATCH = int(os.environ.get("SAM_POINTS_PER_BATCH", "16"))
PRED_IOU_THRESH = float(os.environ.get("SAM_PRED_IOU_THRESH", "0.75"))
STABILITY_SCORE_THRESH = float(os.environ.get("SAM_STABILITY_SCORE_THRESH", "0.85"))
POINTS_PER_SIDE = int(os.environ.get("SAM_POINTS_PER_SIDE", "16"))
CROPS_N_LAYERS = int(os.environ.get("SAM_CROPS_N_LAYERS", "0"))
MAX_SEGMENTS = 254

_state: dict = {}


def _load():
    if "generator" in _state:
        return _state
    
    from mobile_sam import sam_model_registry, SamAutomaticMaskGenerator

    device = "cuda" if torch.cuda.is_available() else "cpu"
    
    # Učitava mobile_sam.pt koji je pripremljen u Dockerfile-u
    mobile_sam = sam_model_registry["vit_t"](checkpoint=MOBILE_SAM_CHECKPOINT)
    mobile_sam.to(device=device)
    mobile_sam.eval()

    generator = SamAutomaticMaskGenerator(
        mobile_sam,
        points_per_side=POINTS_PER_SIDE,
        points_per_batch=POINTS_PER_BATCH,
        pred_iou_thresh=PRED_IOU_THRESH,
        stability_score_thresh=STABILITY_SCORE_THRESH,
        crop_n_layers=CROPS_N_LAYERS,
    )
    
    _state["generator"] = generator
    return _state


def get_label_map(image: Image.Image) -> np.ndarray:
    """Returns a (H, W) uint8 array - 0 = unassigned, 1..N = region id."""
    st = _load()
    orig_w, orig_h = image.size

    img_arr = np.array(image.convert("RGB"))

    with torch.inference_mode():
        sam_masks = st["generator"].generate(img_arr)

    masks_with_area = []
    for seg in sam_masks:
        seg_bool = seg["segmentation"]
        if seg_bool.shape != (orig_h, orig_w):
            continue
        area = int(seg["area"])
        if area == 0:
            continue
        masks_with_area.append((area, seg_bool))

    masks_with_area.sort(key=lambda t: t[0], reverse=True)

    label_map = np.zeros((orig_h, orig_w), dtype=np.uint8)
    next_id = 1
    for area, seg_bool in masks_with_area:
        if next_id > MAX_SEGMENTS:
            break
        label_map[seg_bool] = next_id
        next_id += 1

    if next_id <= MAX_SEGMENTS:
        try:
            from scipy import ndimage
            unassigned = label_map == 0
            labeled_gaps, num_gaps = ndimage.label(unassigned)
            gap_sizes = ndimage.sum(unassigned, labeled_gaps, range(1, num_gaps + 1))
            gap_order = np.argsort(gap_sizes)[::-1]
            for gap_idx in gap_order:
                if next_id > MAX_SEGMENTS:
                    break
                gap_label = gap_idx + 1
                label_map[labeled_gaps == gap_label] = next_id
                next_id += 1
        except ImportError:
            pass

    return label_map