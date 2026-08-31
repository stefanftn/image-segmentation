"""
Wall segmentation API service.

Two ways to get a wall mask/selection for a photo:

1. POST /segment - automatic. Runs a fixed, pre-selected model for the given
   mode ("interior" or "exterior") and returns a binary mask directly.

2. POST /regions - manual/interactive. Runs SAM to split the image into
   visual regions (no semantic knowledge - doesn't know what a "wall" is)
   and returns a label map. Intended for frontends where the user clicks to
   select which regions belong together. Works the same regardless of
   interior/exterior, since the user decides.

Model choices and their trade-offs are documented in models/interior.py and
models/exterior.py.

--------------------------------------------------------------------------
Startup / readiness (added on top of the original single-file design):

Every model used to load lazily, on first request. That's fine for a single
instance running alone, but once several sidecar replicas are started
together (`docker compose up --scale ai-sidecar=N`) it means the first
request to hit each fresh replica pays the full multi-hundred-MB
download+load cost inline, which can easily exceed the worker's HTTP
timeout for that one unlucky request.

Instead, all three models (interior, exterior, SAM) are loaded once at
process startup, and GET /health/ready only returns 200 once all three are
warm. docker-compose's healthcheck polls that endpoint, and the worker's
`depends_on: ai-sidecar: condition: service_healthy` means no traffic is
routed to a replica until it's actually ready to serve at full speed - "hot
when called", not "hot after whichever request happens to arrive first".

GET /health is kept as an alias for /health/ready, matching what the
original README documented - note that this changes its meaning slightly
from "the process is up" to "the process is up AND all models are loaded".
GET /health/live is the new, always-fast "is the process up at all" check.
"""
import io
import logging
import os
import time
from pathlib import Path

import torch
from PIL import Image

from fastapi import FastAPI, UploadFile, File, Form, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, Gauge, generate_latest

logging.basicConfig(level="INFO")
logger = logging.getLogger("wall-segmentation")

# Load .env (if present) before any model module reads its own env vars.
try:
    from dotenv import load_dotenv
    _env_path = Path(__file__).resolve().parent / ".env"
    if load_dotenv(_env_path):
        logger.info("Loaded .env file: %s", _env_path)
except ImportError:
    logger.warning("python-dotenv not installed - .env file will not be loaded. "
                    "Install with: pip install python-dotenv")

from models import interior as interior_model
from models import exterior as exterior_model
from models import regions as regions_model
from models.common import clean_mask

torch.set_num_threads(max(1, (os.cpu_count() or 4) - 1))

DEFAULT_MORPH_RADIUS = int(os.environ.get("SEGMENT_MORPH_RADIUS", "2"))
DEFAULT_MIN_BLOB_PCT = float(os.environ.get("SEGMENT_MIN_BLOB_PCT", "0.5"))

app = FastAPI(title="Wall Segmentation API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Per-model readiness, so a slow/failed download for one model doesn't hide
# whether the other two are already usable - useful when reading logs during
# a slow first-time startup, even though /health/ready itself only exposes
# a single aggregate status (that's the only thing docker-compose/worker act on).
_model_ready = {"interior": False, "exterior": False, "regions": False}

# §12 (docker-compose Prometheus scrape config) — kept from the original stub sidecar so
# ai-sidecar doesn't silently disappear from monitoring with the real models in place.
SEGMENT_REQUESTS = Counter("sidecar_segment_requests", "Segmentation requests", ["mode", "outcome"])
SEGMENT_LATENCY = Histogram("sidecar_segment_latency_seconds", "Segmentation latency", ["mode"])
REGIONS_REQUESTS = Counter("sidecar_regions_requests", "Region-map requests", ["outcome"])
REGIONS_LATENCY = Histogram("sidecar_regions_latency_seconds", "Region-map latency")
MODEL_READY = Gauge("sidecar_model_ready", "1 once a model has finished loading and is ready to serve", ["model"])
for _name in _model_ready:
    MODEL_READY.labels(model=_name).set(0)


@app.on_event("startup")
async def _load_models_on_startup():
    t0 = time.perf_counter()
    logger.info("Loading models eagerly at startup (interior, exterior, regions/SAM)...")

    for name, module in (("interior", interior_model), ("exterior", exterior_model), ("regions", regions_model)):
        try:
            model_t0 = time.perf_counter()
            await run_in_threadpool(module._load)
            _model_ready[name] = True
            MODEL_READY.labels(model=name).set(1)
            logger.info("Loaded %s model in %.1fs", name, time.perf_counter() - model_t0)
        except Exception:
            # Logged and swallowed rather than raised: a failure to download/load one model
            # (e.g. a transient Hugging Face outage) shouldn't take the whole process down and
            # prevent it from ever starting. /health/ready simply stays false until an operator
            # notices the log line and restarts the container to retry.
            logger.exception("Failed to load %s model at startup - it will report unready "
                              "until the container is restarted.", name)

    elapsed = time.perf_counter() - t0
    if all(_model_ready.values()):
        logger.info("All models loaded in %.1fs - ready to serve.", elapsed)
    else:
        missing = [k for k, v in _model_ready.items() if not v]
        logger.warning("Startup finished in %.1fs with models NOT ready: %s", elapsed, missing)


@app.get("/health/live")
async def health_live():
    """Always fast, no dependency on model state - just confirms the process is up."""
    return {"status": "ok"}


@app.get("/health/ready")
async def health_ready():
    """200 only once every model has finished loading; 503 (with a per-model breakdown) until then."""
    ready = all(_model_ready.values())
    body = {"status": "ok" if ready else "loading", "device": "cpu", "models": _model_ready}
    return JSONResponse(body, status_code=200 if ready else 503)


@app.get("/health")
async def health():
    """Alias for /health/ready, matching the endpoint this service originally documented."""
    return await health_ready()


@app.get("/metrics")
async def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


def _run_segment(mode: str, image: Image.Image):
    if mode == "interior":
        return interior_model.get_mask(image)
    return exterior_model.get_mask(image)


@app.post("/segment")
async def segment(
    image: UploadFile = File(...),
    mode: str = Form(...),  # "interior" | "exterior"
    morph_radius: int = Form(default=None),  # 0 = disabled; default SEGMENT_MORPH_RADIUS
    min_blob_pct: float = Form(default=None),  # 0 = disabled; default SEGMENT_MIN_BLOB_PCT
    x_correlation_id: str = Header(default="local-test", alias="X-Correlation-Id"),
):
    if mode not in ("interior", "exterior"):
        raise HTTPException(status_code=422, detail="mode must be 'interior' or 'exterior'.")

    effective_morph = DEFAULT_MORPH_RADIUS if morph_radius is None else morph_radius
    effective_min_blob = DEFAULT_MIN_BLOB_PCT if min_blob_pct is None else min_blob_pct

    try:
        raw_image = Image.open(io.BytesIO(await image.read())).convert("RGB")
    except Exception:
        raise HTTPException(status_code=422, detail="Invalid image file.")

    t0 = time.perf_counter()
    try:
        mask_np = await run_in_threadpool(_run_segment, mode, raw_image)
        mask_np = clean_mask(mask_np, morph_radius=effective_morph, min_blob_pct=effective_min_blob)
    except Exception as e:
        logger.exception("[%s] Error in segment (mode=%s)", x_correlation_id, mode)
        SEGMENT_REQUESTS.labels(mode=mode, outcome="error").inc()
        raise HTTPException(status_code=500, detail=str(e))
    elapsed = time.perf_counter() - t0
    SEGMENT_REQUESTS.labels(mode=mode, outcome="success").inc()
    SEGMENT_LATENCY.labels(mode=mode).observe(elapsed)

    pixel_count = int((mask_np > 0).sum())
    total_pixels = mask_np.size
    coverage = pixel_count / total_pixels if total_pixels else 0.0

    logger.info(
        "[%s] mode=%s -> %.1f%% coverage in %.2fs",
        x_correlation_id, mode, coverage * 100, elapsed,
    )

    output_buffer = io.BytesIO()
    Image.fromarray(mask_np, mode="L").save(output_buffer, format="PNG", optimize=True)

    return Response(
        content=output_buffer.getvalue(),
        media_type="image/png",
        headers={
            "X-Correlation-Id": x_correlation_id,
            "X-Mode": mode,
            "X-Coverage-Pct": f"{coverage * 100:.2f}",
            "X-Elapsed-Ms": f"{elapsed * 1000:.0f}",
            "X-Morph-Radius": str(effective_morph),
            "X-Min-Blob-Pct": str(effective_min_blob),
        },
    )


@app.post("/regions")
async def regions(
    image: UploadFile = File(...),
    x_correlation_id: str = Header(default="local-test", alias="X-Correlation-Id"),
):
    try:
        raw_image = Image.open(io.BytesIO(await image.read())).convert("RGB")
    except Exception:
        raise HTTPException(status_code=422, detail="Invalid image file.")

    t0 = time.perf_counter()
    try:
        label_map = await run_in_threadpool(regions_model.get_label_map, raw_image)
    except Exception as e:
        logger.exception("[%s] Error computing SAM regions", x_correlation_id)
        REGIONS_REQUESTS.labels(outcome="error").inc()
        raise HTTPException(status_code=500, detail=str(e))
    elapsed = time.perf_counter() - t0
    REGIONS_REQUESTS.labels(outcome="success").inc()
    REGIONS_LATENCY.observe(elapsed)

    segment_count = int(label_map.max())
    logger.info("[%s] /regions -> %d regions in %.2fs", x_correlation_id, segment_count, elapsed)

    output_buffer = io.BytesIO()
    Image.fromarray(label_map, mode="L").save(output_buffer, format="PNG")

    return Response(
        content=output_buffer.getvalue(),
        media_type="image/png",
        headers={
            "X-Correlation-Id": x_correlation_id,
            "X-Segment-Count": str(segment_count),
            "X-Elapsed-Ms": f"{elapsed * 1000:.0f}",
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000, workers=1)
