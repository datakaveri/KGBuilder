"""FastAPI app: pipeline streaming, LLM health check, file upload, downloads, and the built React UI."""
import asyncio
import io
import json
import re
import time

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from atlas_rag.llm_generator.prompt.triple_extraction_prompt import TRIPLE_INSTRUCTIONS

from . import __version__, config
from .llm import default_client
from .pipeline import PipelineRequest, run_pipeline

app = FastAPI(title="KG Studio", version=__version__)
llm = default_client()

DOWNLOADS = {"graph.jsonld", "graph.json", "graph.graphml", "extraction.json", "concepts.json", "metrics.json"}


@app.post("/api/pipeline")
async def pipeline(req: PipelineRequest):
    return StreamingResponse(run_pipeline(req, llm), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/healthz")
async def healthz():
    """Liveness only — does not call the LLM."""
    return {"ok": True, "version": __version__}


@app.get("/api/config")
async def get_config():
    """UI options only. LLM settings live in `.env` and are deliberately not exposed."""
    return {"languages": list(TRIPLE_INSTRUCTIONS.keys())}


@app.post("/api/health")
async def health():
    """Round-trip ping to the configured LLM (`curl -X POST localhost:8000/api/health`)."""
    t0 = time.time()
    try:
        out = await asyncio.wait_for(llm.generate("Reply with the single word: pong", max_tokens=200), 60)
        return {"ok": True, "reply": out[:200], "seconds": round(time.time() - t0, 2)}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "seconds": round(time.time() - t0, 2)}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    data = await file.read()
    name = (file.filename or "").lower()
    if name.endswith(".pdf"):
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        text = "\n\n".join((p.extract_text() or "") for p in reader.pages)
    elif name.endswith(".json"):
        parsed = json.loads(data)
        items = parsed if isinstance(parsed, list) else [parsed]
        text = "\n\n".join(i.get("text", "") if isinstance(i, dict) else str(i) for i in items)
    else:
        text = data.decode("utf-8", errors="replace")
    text = re.sub(r"[ \t]+", " ", text).strip()
    if not text:
        raise HTTPException(400, "No text could be extracted from that file.")
    return {"filename": file.filename, "text": text, "chars": len(text)}


@app.get("/api/download/{run_id}/{name}")
async def download(run_id: str, name: str):
    if name not in DOWNLOADS or not re.fullmatch(r"[\d-]+", run_id):
        raise HTTPException(404)
    path = config.OUTPUT_DIR / run_id / name
    if not path.exists():
        raise HTTPException(404)
    media = "application/ld+json" if name.endswith(".jsonld") else None
    return FileResponse(path, filename=name, media_type=media)


if (config.WEB_DIST / "index.html").exists():
    app.mount("/assets", StaticFiles(directory=config.WEB_DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    async def spa(path: str):
        return FileResponse(config.WEB_DIST / "index.html")
else:
    @app.get("/")
    async def no_build():
        return JSONResponse({"message": "UI not built. For development run `make dev` (UI on http://localhost:5173), "
                                        "or `make build` to serve the UI from this server."})
