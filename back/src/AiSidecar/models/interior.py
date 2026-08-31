"""
Interior wall segmentation.

Model: SegFormer-b0 fine-tuned on ADE20K. Targets the "wall" class only -
ADE20K's "wall" label is used almost exclusively for indoor walls, so this
model performs reliably and quickly for interior scenes. Chosen as the best
option after comparing 8 different architectures (SegFormer variants,
MaskFormer, Mask2Former, BEiT, UperNet, OneFormer): all gave near-identical,
consistently accurate results on interior test images, and this is the
fastest of them.
"""
import os

import torch
import torch.nn.functional as F
import numpy as np
from PIL import Image
from transformers import AutoImageProcessor, SegformerForSemanticSegmentation

from models.common import resolve_class_ids, mask_from_class_map, DEVICE

MODEL_ID = os.environ.get("INTERIOR_MODEL_ID", "nvidia/segformer-b0-finetuned-ade-512-512")
TARGET_LABELS = ["wall"]

_state: dict = {}


def _load():
    if "model" in _state:
        return _state
    processor = AutoImageProcessor.from_pretrained(MODEL_ID)
    model = SegformerForSemanticSegmentation.from_pretrained(MODEL_ID)
    model.to(DEVICE)
    model.eval()
    _state["processor"] = processor
    _state["model"] = model
    _state["target_ids"] = resolve_class_ids(model.config.id2label, TARGET_LABELS)
    return _state


def get_mask(image: Image.Image) -> np.ndarray:
    """Returns a (H, W) uint8 mask (0/255) marking interior wall pixels."""
    st = _load()
    orig_w, orig_h = image.size
    target_ids = st["target_ids"]
    if not target_ids:
        raise RuntimeError(f"{MODEL_ID}: none of the target classes were found in the model vocabulary.")

    with torch.inference_mode():
        inputs = st["processor"](images=image, return_tensors="pt").to(DEVICE)
        logits = st["model"](**inputs).logits
        upsampled = F.interpolate(logits, size=(orig_h, orig_w), mode="bilinear", align_corners=False)
        class_map = upsampled.argmax(dim=1)[0]

    mask_bool = mask_from_class_map(class_map, target_ids)
    return (mask_bool.numpy().astype(np.uint8)) * 255
