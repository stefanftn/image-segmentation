FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1

# Model weights are fetched from Hugging Face at container STARTUP, not baked into the image
# (see main.py's eager-load startup handler) — HF_HOME/TRANSFORMERS_CACHE point at a fixed
# path regardless of the container user's HOME, so it can be mounted as a predictable named
# volume in docker-compose.yml and survive container recreation (`docker compose up
# --build`), instead of re-downloading 500MB-1GB every time.
ENV HF_HOME=/models-cache
ENV TRANSFORMERS_CACHE=/models-cache

# `pip install torch` with no index override pulls the default (CUDA-enabled) build, which is
# several GB and entirely wasted here — models/common.py hardcodes DEVICE = torch.device("cpu")
# and the README documents this service as CPU-only. Installing from the CPU wheel index first
# means the plain `torch` entry in requirements.txt below is already satisfied and pip won't
# re-fetch the GPU build.
#
# torchvision alongside it: transformers' AutoImageProcessor (used by both interior.py and
# exterior.py) requires it for image preprocessing and fails to import without it — this was
# missing from the original requirements.txt and from here on the first pass, surfacing only
# at model-load time ("AutoImageProcessor requires the Torchvision library"), not at pip
# install time.
#
# Version 2.6.0 specifically (bumped twice from an initial 2.4.1 attempt):
# - requirements.txt pins `transformers` to nothing, so pip installs whatever is current at
#   build time, and current transformers releases refuse to enable their PyTorch integration
#   at all below torch 2.5 ("[transformers] Disabling PyTorch because PyTorch >= 2.5 is
#   required") — silently, not as an install-time error.
# - Separately, transformers now refuses `torch.load()` (used for any checkpoint NOT in
#   safetensors format) below torch 2.6, as a blanket version gate for CVE-2025-32434 — this
#   bit specifically nvidia/segformer-b4-finetuned-ade-512-512 (used by exterior.py's
#   silhouette model), which has no safetensors file on its main branch and falls back to the
#   legacy pytorch_model.bin format. interior.py's segformer-b0 checkpoint DOES ship
#   safetensors and was unaffected by this specific gate, which is why it loaded fine before
#   this bump while exterior failed.
# 2.6.0 / 0.21.0 are an official matched torch/torchvision release pair.
RUN pip install --no-cache-dir torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000
# One worker per container: replicas are the scaling unit (docker compose up --scale
# ai-sidecar=N), matching how the .NET services scale.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
