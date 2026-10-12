"""End-to-end pipeline runs against the fake LLM (both Ollama and OpenAI-style providers)."""
import json

import pytest
from fastapi.testclient import TestClient

from kgstudio import app as app_module
from kgstudio import config
from kgstudio.pipeline import PipelineRequest, run_pipeline

TEXT = "Metformin is a drug. The FDA approved it in 1994. Dr. Sarah Chen led a trial at Johns Hopkins."


async def collect(req, llm):
    return [json.loads(line) async for line in run_pipeline(req, llm)]


def steps(events):
    return {e["step"]: e["status"] for e in events if e["type"] == "step" and e["status"] != "running"}


@pytest.mark.parametrize("method", ["hybrid", "autoschema", "socratic"])
async def test_pipeline_runs_every_method(fake_llm, method):
    events = await collect(PipelineRequest(text=TEXT, method=method), fake_llm)
    assert events[-1]["type"] == "done"
    st = steps(events)
    assert st["final"] == "done" and st["canon"] == "done"
    assert st["qa"] == ("skipped" if method == "autoschema" else "done")
    assert not [e for e in events if e["type"] == "llm_end" and not e["ok"]]

    final = next(e for e in events if e["type"] == "final_graph")
    out = config.OUTPUT_DIR / final["run_id"]
    for name in ("graph.jsonld", "graph.json", "graph.graphml", "extraction.json", "concepts.json", "metrics.json"):
        assert (out / name).exists()
    sources = {s for e in final["graph"]["edges"] for s in e["sources"]}
    expected = {"hybrid": {"autoschema", "socratic"}, "autoschema": {"autoschema"}, "socratic": {"socratic"}}
    assert sources == expected[method]


async def test_hybrid_canonicalization_joins_both_extractors(fake_llm):
    events = await collect(PipelineRequest(text=TEXT, method="hybrid"), fake_llm)
    canon = next(e for e in events if e["type"] == "canon" and e["kind"] == "entity")
    assert {"canonical": "Food and Drug Administration", "members": ["FDA", "Food and Drug Administration"]} \
        in [{"canonical": m["canonical"], "members": sorted(m["members"])} for m in canon["merges"]]
    graph = next(e for e in events if e["type"] == "base_graph")
    both = [e for e in graph["graph"]["edges"] if len(e["sources"]) == 2]
    assert any(e["relation"] == "approved" and e["count"] == 2 for e in both)
    assert graph["metrics"]["after"]["both"]["triples"] >= 1 and "before" in graph["metrics"]


async def test_canonicalization_can_be_disabled(fake_llm):
    events = await collect(PipelineRequest(text=TEXT, method="hybrid", canonicalize=False, conceptualize=False), fake_llm)
    st = steps(events)
    assert st["canon"] == "skipped" and st["concept"] == "skipped" and st["final"] == "done"


async def test_qa_batching_reduces_calls(fake_llm):
    events = await collect(PipelineRequest(text=TEXT, method="socratic", qa_batch_size=3, conceptualize=False), fake_llm)
    assert sum(1 for e in events if e["type"] == "llm_start" and e["stage"] == "qa_triple") == 1


def test_http_api(monkeypatch, fake_llm):
    monkeypatch.setattr(app_module, "llm", fake_llm)
    client = TestClient(app_module.app)
    assert client.get("/api/healthz").json()["ok"] is True
    assert "en" in client.get("/api/config").json()["languages"]
    assert client.post("/api/health").json()["reply"] == "pong"
    up = client.post("/api/upload", files={"file": ("doc.txt", b"Hello   world", "text/plain")}).json()
    assert up["text"] == "Hello world"
    with client.stream("POST", "/api/pipeline", json={"text": TEXT, "method": "autoschema"}) as r:
        events = [json.loads(line) for line in r.iter_lines() if line]
    run_id = next(e for e in events if e["type"] == "final_graph")["run_id"]
    assert client.get(f"/api/download/{run_id}/graph.json").status_code == 200
    ld = client.get(f"/api/download/{run_id}/graph.jsonld")
    assert ld.status_code == 200 and ld.headers["content-type"].startswith("application/ld+json")
    # Only whitelisted file names and numeric run ids are served.
    assert client.get(f"/api/download/{run_id}/secrets.txt").status_code == 404
    assert client.get("/api/download/not-a-run/graph.json").status_code == 404
