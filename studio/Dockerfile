# syntax=docker/dockerfile:1
# KG Studio — one image: the React UI is built in stage 1 and served by the FastAPI backend.
# Build context is the repository root:
#   docker build -f studio/Dockerfile -t kg-studio .

# ---------- stage 1: build the web UI ----------
FROM node:22-alpine AS web
WORKDIR /web
COPY studio/web/package.json studio/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY studio/web/ ./
RUN npm run build

# ---------- stage 2: Python backend ----------
FROM python:3.11-slim AS app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/opt/hf \
    KGSTUDIO_OUTPUT_DIR=/app/output/ui_runs \
    KGSTUDIO_WEB_DIST=/app/studio/web/dist

WORKDIR /app

# CPU-only PyTorch keeps the image ~1.5 GB instead of pulling CUDA wheels.
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch

# KG Studio backend + its dependencies, including AutoSchemaKG (atlas-rag) from PyPI.
# Dependencies are installed before the source is copied so code edits don't re-download them.
# (A throwaway stub package is installed only to resolve dependencies, then removed entirely —
# including setuptools' build/ dir, which would otherwise shadow the real sources below.)
COPY studio/backend/pyproject.toml /tmp/deps/pyproject.toml
RUN mkdir -p /tmp/deps/kgstudio && touch /tmp/deps/kgstudio/__init__.py \
    && pip install /tmp/deps && pip uninstall -y kgstudio && rm -rf /tmp/deps
COPY studio/backend ./studio/backend
RUN pip install --no-deps ./studio/backend && rm -rf ./studio/backend/build

# Bake the default embedding model into the image so canonicalization works offline.
# Build with --build-arg PRELOAD_EMBED_MODEL= to skip.
ARG PRELOAD_EMBED_MODEL=BAAI/bge-small-en-v1.5
RUN if [ -n "$PRELOAD_EMBED_MODEL" ]; then \
      python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('$PRELOAD_EMBED_MODEL')"; \
    fi

COPY --from=web /web/dist ./studio/web/dist
COPY studio/samples ./studio/samples

RUN useradd --create-home --uid 1000 studio \
    && mkdir -p /app/output && chown -R studio:studio /app/output /opt/hf
USER studio

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/healthz', timeout=4)"

CMD ["python", "-m", "kgstudio", "--host", "0.0.0.0", "--port", "8000"]
