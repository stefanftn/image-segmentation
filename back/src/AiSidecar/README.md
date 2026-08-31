# Wall Segmentation API

A small FastAPI service for isolating walls in interior/exterior photos.
CPU-only, no GPU required.

## Setup

```
pip install -r requirements.txt
copy .env.example .env      # Windows; adjust values if needed (optional)
uvicorn main:app --host 127.0.0.1 --port 8000
```

First request for each model will download its weights from Hugging Face
(cached locally afterwards). Total download size is roughly 500MB-1GB
across the interior/exterior models plus SAM.

## Endpoints

### `POST /segment`

Automatic mask generation. Runs one fixed, pre-selected model depending on
`mode`.

**Form fields:**
| Field | Required | Description |
|---|---|---|
| `image` | yes | Image file |
| `mode` | yes | `"interior"` or `"exterior"` |
| `morph_radius` | no | Overrides `SEGMENT_MORPH_RADIUS` for this request. `0` disables. |
| `min_blob_pct` | no | Overrides `SEGMENT_MIN_BLOB_PCT` for this request. `0` disables. |

**Response:** `image/png`, grayscale, wall pixels = 255, everything else = 0.

**Response headers:** `X-Coverage-Pct`, `X-Elapsed-Ms`, `X-Mode`,
`X-Morph-Radius`, `X-Min-Blob-Pct`.

**Known limitation (exterior only):** the roof is not excluded from the
mask - no reliable, general-purpose model was found for that on street-level
photos. If exact roof exclusion is required, use `/regions` instead and let
the user pick manually.

### `POST /regions`

Manual/interactive mode. Splits the image into visual regions using SAM,
with no semantic knowledge (doesn't know what a "wall" is - purely
boundary-based). Intended for a frontend where the user clicks regions to
build a selection (e.g. to precisely exclude a roof, or select any other
object).

**Form fields:** `image` (required). No `mode` needed - this works the same
regardless of interior/exterior.

**Response:** `image/png`, grayscale "label map" - each pixel's value is the
id (1-254) of the region it belongs to, `0` = unassigned/background.

**Response headers:** `X-Segment-Count`, `X-Elapsed-Ms`.

**Frontend usage pattern:**
1. Draw the label map PNG onto an offscreen canvas, read its pixel data.
2. On click, read the label-map value at the clicked pixel -> region id.
3. Maintain a set of selected region ids (grouped however your UI wants).
4. To render/export a mask for a selection: for every pixel, check whether
   its label-map value is in the selected id set.

This can take anywhere from a few seconds to a couple of minutes on CPU,
depending on image size - it's a heavier operation than `/segment`.

### `GET /health`, `GET /health/live`, `GET /health/ready`

`/health/live` is a fast, dependency-free check that the process is up. `/health/ready`
returns `200 {"status": "ok", "device": "cpu", "models": {...}}` only once all three models
(interior, exterior, SAM) have finished loading at startup — `503` with the same body
otherwise, so a caller can see exactly which model is still pending. `/health` is kept as an
alias for `/health/ready` for compatibility with what's documented here, which changes its
meaning slightly from "the process is up" to "the process is up AND ready to serve at full
speed" — deliberate, so an orchestrator's readiness probe never routes traffic to a replica
that's still mid-download.

### `GET /metrics`

Prometheus exposition format: `sidecar_segment_requests_total{mode,outcome}`,
`sidecar_regions_requests_total{outcome}`, `sidecar_segment_latency_seconds`,
`sidecar_regions_latency_seconds`, `sidecar_model_ready{model}` (1 once that model has loaded).

## Configuration

All configuration is via environment variables (or `.env`, see
`.env.example`) - model checkpoints, SAM detection thresholds, and default
post-processing parameters. See `.env.example` for the full list.

## Project structure

```
main.py              FastAPI app - /segment, /regions, /health
models/
  common.py           Shared helpers (class-id resolution, mask cleanup)
  interior.py          Interior wall model (SegFormer-b0, ADE20K)
  exterior.py           Exterior wall model (SegFormer-b4 + CMP facade composite)
  regions.py             SAM region computation for /regions
```

## Notes on model choices

These were chosen after comparing roughly 15 different open-source models
and combinations (various SegFormer sizes, MaskFormer, Mask2Former, BEiT,
UperNet, OneFormer, Cityscapes/CMP/ADE20K-Full variants, and a hosted
Roboflow model). See the module docstrings in `models/interior.py` and
`models/exterior.py` for what each model does and why it was picked over
the alternatives.
