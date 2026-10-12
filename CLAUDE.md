# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

KG Studio: a step-by-step web UI and hybrid knowledge-graph pipeline combining AutoSchemaKG (the `atlas-rag`
package, installed from PyPI, **not** vendored) and SocraticKG (Findings of ACL 2026). README.md has the
user-facing docs. The upstream AutoSchemaKG clone lives outside this repo (`../AutoSchemaKG`) for reference only.

## Layout

- `studio/backend/kgstudio/`: FastAPI package. `pipeline.py` streams NDJSON events; `socratic.py` holds the
  SocraticKG prompts verbatim from the paper; `canonicalize.py` → `graph.py` (MultiDiGraph whose edges carry
  `sources` + `evidence`) → AutoSchemaKG conceptualization → `metrics.py`; `rdf.py` exports the final graph as
  RDF JSON-LD (`graph.jsonld`, validated with rdflib in `tests/test_rdf.py`).
- `studio/web/`: React + Vite + TS. `usePipeline.ts` reduces the event stream; `components/StepViews.tsx` has one view
  per step; graph styling constants are in `components/graphStyle.ts`.
- `studio/Dockerfile` (context = repo root) and `docker-compose.yml` (optional `ollama` profile).

## Commands

```bash
make setup        # .venv + pip install -e "studio/backend[dev]" + npm ci
make dev          # backend :8000 + Vite :5173
make test         # pytest (fake LLM in tests/conftest.py, TF-IDF embeddings, no network) + UI build
make lint
docker compose up -d --build
```

Single backend test: `cd studio/backend && ../../.venv/bin/python -m pytest -q tests/test_graph.py`.

## Conventions

- Config comes only from env / repo-root `.env` via `kgstudio/config.py`. LLM settings (endpoint, model, concurrency,
  max tokens) are env-only by design: don't expose them in the UI or `/api/config`.
- Adding a step means: an event in `pipeline.py`, a reducer case in `usePipeline.ts`, a view in `StepViews.tsx`,
  and a test in `tests/test_pipeline.py`.
- Use AutoSchemaKG prompts and `TextChunker` from `atlas_rag` as-is; wrap rather than modify them.
