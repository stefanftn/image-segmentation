"""
Shared helper functions used by both the interior and exterior wall
segmentation models.
"""
import torch

DEVICE = torch.device("cpu")


def resolve_class_ids(id2label: dict, wanted_labels: list[str]) -> set[int]:
    """Finds class ids by label name (case-insensitive), instead of relying
    on hardcoded numeric indices that differ from checkpoint to checkpoint.

    id2label: model.config.id2label ({index: "label name"} mapping)
    wanted_labels: list of label names to look for, e.g. ["wall", "building"]
    """
    normalized: dict[int, str] = {}
    for k, v in id2label.items():
        idx = int(k)
        normalized[idx] = str(v).strip().lower()

    resolved: set[int] = set()
    for wanted in wanted_labels:
        w = wanted.strip().lower()
        for idx, name in normalized.items():
            # exact match, or match against one of the ";"-separated synonyms
            if w == name or w in [p.strip() for p in name.split(";")]:
                resolved.add(idx)
    return resolved


def mask_from_class_map(class_map: torch.Tensor, target_class_ids: set[int]):
    """Converts a (H, W) class-id map into a boolean mask for the given classes."""
    mask_bool = torch.zeros_like(class_map, dtype=torch.bool)
    for cls_id in target_class_ids:
        mask_bool |= class_map == cls_id
    return mask_bool


def mask_from_class_map_excluding(
    class_map: torch.Tensor, include_ids: set[int], exclude_ids: set[int]
):
    """Like mask_from_class_map, but explicitly subtracts exclude_ids classes
    (e.g. windowpane/door) from the result."""
    include_mask = mask_from_class_map(class_map, include_ids)
    if exclude_ids:
        exclude_mask = mask_from_class_map(class_map, exclude_ids)
        include_mask = include_mask & (~exclude_mask)
    return include_mask


def clean_mask(
    mask_np: "np.ndarray",
    morph_radius: int = 2,
    min_blob_pct: float = 0.5,
) -> "np.ndarray":
    """Post-processing applied to any binary mask before it's returned:

    - morph_radius: kernel size for morphological closing (fills small holes/
      gaps in the mask) and opening (removes small isolated noise specks).
      0 = disabled.
    - min_blob_pct: removes connected blobs smaller than this percentage of
      total image pixels (0.5 = 0.5%). 0 = disabled. Useful for removing
      small false-positive detections scattered around the image.
    """
    import numpy as np
    from PIL import Image, ImageFilter

    if morph_radius > 0:
        size = morph_radius * 2 + 1
        mask_img = Image.fromarray(mask_np)
        # closing (dilate->erode): fills small holes/gaps
        mask_img = mask_img.filter(ImageFilter.MaxFilter(size))
        mask_img = mask_img.filter(ImageFilter.MinFilter(size))
        # opening (erode->dilate): removes small isolated specks
        mask_img = mask_img.filter(ImageFilter.MinFilter(size))
        mask_img = mask_img.filter(ImageFilter.MaxFilter(size))
        mask_np = np.array(mask_img)

    if min_blob_pct > 0:
        try:
            from scipy import ndimage
            labeled, num_features = ndimage.label(mask_np > 0)
            if num_features > 0:
                total_pixels = mask_np.size
                min_pixels = total_pixels * (min_blob_pct / 100.0)
                sizes = ndimage.sum(mask_np > 0, labeled, range(1, num_features + 1))
                small_labels = [i + 1 for i, s in enumerate(sizes) if s < min_pixels]
                if small_labels:
                    remove = np.isin(labeled, small_labels)
                    mask_np = mask_np.copy()
                    mask_np[remove] = 0
        except ImportError:
            pass  # scipy not installed - min_blob_pct filter is skipped

    return mask_np
