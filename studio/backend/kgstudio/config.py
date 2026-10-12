"""Runtime settings, read from the environment (and a repo-root `.env` for local runs)."""
import os
from pathlib import Path

# studio/backend/kgstudio/config.py -> repo root
REPO_ROOT = Path(__file__).resolve().parents[3]


def load_env(path: Path):
    """Minimal .env loader; real environment variables always win."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env(REPO_ROOT / ".env")

# LLM
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "ollama").lower()  # ollama | openai
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "http://localhost:11434").rstrip("/")
LLM_GENERATE_PATH = os.environ.get(
    "LLM_GENERATE_PATH", "/api/generate" if LLM_PROVIDER == "ollama" else "/v1/chat/completions"
)
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-20b")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_TIMEOUT = float(os.environ.get("LLM_TIMEOUT", "600"))
LLM_TEMPERATURE = float(os.environ.get("LLM_TEMPERATURE", "0.1"))
LLM_CONCURRENCY = int(os.environ.get("LLM_CONCURRENCY", "4"))  # parallel requests per run
LLM_MAX_TOKENS = int(os.environ.get("LLM_MAX_TOKENS", "4096"))   # completion budget per request

# Embeddings for canonicalization ("tfidf" forces the offline fallback)
EMBED_MODEL = os.environ.get("EMBED_MODEL", "BAAI/bge-small-en-v1.5")

# RDF export: IRIs in graph.jsonld are minted under this base (e.g. https://example.org/kg/)
RDF_BASE_IRI = os.environ.get("RDF_BASE_IRI", "urn:kgstudio:")

# Server
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))
OUTPUT_DIR = Path(os.environ.get("KGSTUDIO_OUTPUT_DIR", REPO_ROOT / "output" / "ui_runs"))
WEB_DIST = Path(os.environ.get("KGSTUDIO_WEB_DIST", REPO_ROOT / "studio" / "web" / "dist"))
