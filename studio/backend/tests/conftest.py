"""Shared fixtures: an in-process fake LLM (no network, no model) and offline embeddings."""
import json
import re

import httpx
import pytest

from kgstudio import canonicalize, config
from kgstudio.llm import LLMClient


def fake_reply(prompt: str) -> str:
    """Canned answers keyed on which pipeline prompt is being sent."""
    if "Comprehensive Knowledge Archivist" in prompt:
        return json.dumps([
            {"question": "Who approved metformin?", "answer": "The Food and Drug Administration approved metformin in 1994."},
            {"question": "What does metformin treat?", "answer": "Metformin treats type 2 diabetes."},
            {"question": "Why did the ADA update its guidelines?",
             "answer": "The American Diabetes Association updated its guidelines because a clinical trial found lower cardiovascular risk."},
        ])
    if "Semantic Knowledge Graph Builder" in prompt:
        if "Who approved" in prompt:
            return '[{"entity1":"Food and Drug Administration","relation":"approved","entity2":"metformin"},' \
                   '{"entity1":"it","relation":"was","entity2":"1994"}]'
        if "What does metformin treat" in prompt:
            return '[{"entity1":"Metformin","relation":"treats","entity2":"type 2 diabetes"}]'
        return '[{"entity1":"American Diabetes Association","relation":"updated","entity2":"guidelines"}]'
    if "canonicalizing" in prompt:
        items = re.findall(r"^- (.+)$", prompt, re.M)
        low = [i.lower() for i in items]
        if "fda" in low and "food and drug administration" in low:
            return json.dumps([{"representative": "Food and Drug Administration",
                                "members": [items[low.index("fda")], items[low.index("food and drug administration")]]}])
        return "[]"
    if "important entities and the relations" in prompt:
        return '```json\n[{"Head":"Metformin","Relation":"treats","Tail":"type 2 diabetes"},' \
               '{"Head":"FDA","Relation":"approved","Tail":"Metformin"},{"Head":"","Relation":"x","Tail":"y"}]\n```'
    if "participation relations" in prompt:
        return '[{"Event":"The FDA approved metformin in 1994","Entity":["FDA","Metformin"]}]'
    if "relationships between the events" in prompt:
        return '[{"Head":"A trial found lower cardiovascular risk","Relation":"as a result",' \
               '"Tail":"The ADA updated its guidelines"}]'
    if "pong" in prompt:
        return "pong"
    return "drug, medication, treatment"


def _handler(provider: str):
    def handle(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if provider == "openai":
            prompt = body["messages"][-1]["content"]
            return httpx.Response(200, json={"choices": [{"message": {"content": fake_reply(prompt)}}]})
        return httpx.Response(200, json={"model": body["model"], "response": fake_reply(body["prompt"]), "done": True})
    return handle


@pytest.fixture(params=["ollama", "openai"])
def fake_llm(request) -> LLMClient:
    provider = request.param
    path = "/api/generate" if provider == "ollama" else "/v1/chat/completions"
    return LLMClient(provider, "http://fake-llm", path, "test-model", 30,
                     transport=httpx.MockTransport(_handler(provider)))


@pytest.fixture(autouse=True)
def offline(monkeypatch, tmp_path):
    """Use TF-IDF embeddings (no model download) and write run outputs to a temp dir."""
    monkeypatch.setattr(canonicalize, "EMBED_MODEL", "tfidf")
    monkeypatch.setattr(canonicalize, "embedder", canonicalize.Embedder())
    monkeypatch.setattr(config, "OUTPUT_DIR", tmp_path / "runs")
