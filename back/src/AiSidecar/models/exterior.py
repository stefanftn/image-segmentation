"""
Exterior wall/facade segmentation.

This is a composite of two models, combined because no single available
model reliably isolates just the wall on exterior photos:

1. SegFormer-b4 (ADE20K) - gives a rough but well-bounded silhouette of the
   whole house/building (via the "house"/"building"/"skyscraper"/etc.
   classes). Good outer boundary (doesn't bleed much into trees/sky), but
   treats the whole building as one blob (includes windows, doors, roof).

2. SegFormer fine-tuned on the CMP Facade Database - has a separate "facade"
   class that excludes windows and doors. Poor generalization on its own
   (trained on a narrow set of rectified European facade photos), but its
   window/door boundaries are reliably clean.

Final mask = (1) MINUS the window/door regions detected by (2). This keeps
model (1)'s good outer boundary while using model (2) only for what it does
well - cutting out openings.

KNOWN LIMITATION: the roof is NOT excluded. Neither model has a usable
"roof" class for street-level photos (ADE20K lumps it into the building
blob; CMP has no roof class at all). No downloadable, general-purpose model
was found that reliably separates roof from wall on casual photos taken
from the street (as opposed to aerial/satellite photos, which use a
completely different, unrelated model family for solar-panel siting).
If precise roof exclusion matters, use the /regions endpoint (SAM-based
manual region selection) instead.
"""
import os

import torch
import torch.nn.functional as F
import numpy as np
from PIL import Image
from transformers import AutoImageProcessor, SegformerForSemanticSegmentation

from models.common import resolve_class_ids, mask_from_class_map, DEVICE

SILHOUETTE_MODEL_ID = os.environ.get(
    "EXTERIOR_SILHOUETTE_MODEL_ID", "nvidia/segformer-b4-finetuned-ade-512-512"
)
SILHOUETTE_LABELS = ["building", "wall", "house", "skyscraper", "tower", "hovel"]

DETAIL_MODEL_ID = os.environ.get(
    "EXTERIOR_DETAIL_MODEL_ID", "Xpitfire/segformer-finetuned-segments-cmp-facade"
)
# Many community fine-tune repos don't commit their own preprocessor_config.json.
# All SegFormer checkpoints share the same preprocessing algorithm, so it's
# safe to borrow one from an official checkpoint if the repo doesn't have one.
_DETAIL_PROCESSOR_FALLBACK = "nvidia/segformer-b0-finetuned-ade-512-512"
OPENINGS_LABELS = ["window", "door"]

_state: dict = {}


def _load():
    if "silhouette_model" in _state:
        return _state

    silhouette_processor = AutoImageProcessor.from_pretrained(SILHOUETTE_MODEL_ID)
    silhouette_model = SegformerForSemanticSegmentation.from_pretrained(SILHOUETTE_MODEL_ID)
    silhouette_model.to(DEVICE)
    silhouette_model.eval()

    try:
        detail_processor = AutoImageProcessor.from_pretrained(DETAIL_MODEL_ID)
    except OSError:
        detail_processor = AutoImageProcessor.from_pretrained(_DETAIL_PROCESSOR_FALLBACK)
    detail_model = SegformerForSemanticSegmentation.from_pretrained(DETAIL_MODEL_ID)
    detail_model.to(DEVICE)
    detail_model.eval()

    _state["silhouette_processor"] = silhouette_processor
    _state["silhouette_model"] = silhouette_model
    _state["silhouette_ids"] = resolve_class_ids(silhouette_model.config.id2label, SILHOUETTE_LABELS)

    _state["detail_processor"] = detail_processor
    _state["detail_model"] = detail_model
    _state["openings_ids"] = resolve_class_ids(detail_model.config.id2label, OPENINGS_LABELS)

    return _state


def _silhouette_mask(image: Image.Image, orig_h: int, orig_w: int, st: dict) -> np.ndarray:
    target_ids = st["silhouette_ids"]
    if not target_ids:
        raise RuntimeError(f"{SILHOUETTE_MODEL_ID}: none of the target classes were found.")

    with torch.inference_mode():
        inputs = st["silhouette_processor"](images=image, return_tensors="pt").to(DEVICE)
        logits = st["silhouette_model"](**inputs).logits
        upsampled = F.interpolate(logits, size=(orig_h, orig_w), mode="bilinear", align_corners=False)
        class_map = upsampled.argmax(dim=1)[0]

    return mask_from_class_map(class_map, target_ids)


def _openings_mask(image: Image.Image, orig_h: int, orig_w: int, st: dict) -> np.ndarray:
    openings_ids = st["openings_ids"]
    if not openings_ids:
        raise RuntimeError(f"{DETAIL_MODEL_ID}: 'window'/'door' classes were not found.")

    with torch.inference_mode():
        inputs = st["detail_processor"](images=image, return_tensors="pt").to(DEVICE)
        logits = st["detail_model"](**inputs).logits
        upsampled = F.interpolate(logits, size=(orig_h, orig_w), mode="bilinear", align_corners=False)
        class_map = upsampled.argmax(dim=1)[0]

    return mask_from_class_map(class_map, openings_ids)


def get_mask(image: Image.Image) -> np.ndarray:
    """Returns a (H, W) uint8 mask (0/255) marking exterior wall/facade pixels
    (windows and doors excluded; roof is NOT excluded - see module docstring)."""
    st = _load()
    orig_w, orig_h = image.size

    silhouette_bool = _silhouette_mask(image, orig_h, orig_w, st)
    openings_bool = _openings_mask(image, orig_h, orig_w, st)

    combined = silhouette_bool & (~openings_bool)
    return (combined.numpy().astype(np.uint8)) * 255
