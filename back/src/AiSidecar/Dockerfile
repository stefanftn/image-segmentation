FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1

ENV HF_HOME=/models-cache
ENV TRANSFORMERS_CACHE=/models-cache

# Instaliramo git (potreban za pip install MobileSAM sa GitHub-a) i wget (za skidanje mobile_sam.pt)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    wget \
    && rm -rf /var/lib/apt-get/lists/*

# PyTorch CPU verzije
RUN pip install --no-cache-dir torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cpu

# Instalacija MobileSAM paketa sa GitHub-a
RUN pip install --no-cache-dir git+https://github.com/ChaoningZhang/MobileSAM.git

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Preuzimanje mobile_sam.pt težina direktno u image (smešta se u /app/mobile_sam.pt)
RUN wget -q https://github.com/ChaoningZhang/MobileSAM/raw/master/weights/mobile_sam.pt -O /app/mobile_sam.pt

COPY . .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]