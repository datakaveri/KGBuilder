"""
The KG construction pipeline, streamed as NDJSON events.

Three extraction methods:
  * autoschema — AutoSchemaKG: 3 direct extraction passes per chunk
                 (entity-relation, event-entity, event-relation)
  * socratic   — SocraticKG (Findings of ACL 2026): 5W1H-guided QA generation -> triples per QA pair
  * hybrid     — both extractors, merged into one graph

All methods then share: canonicalization (KGGen-style cluster-then-refine, optional) ->
graph integration with evidence -> AutoSchemaKG conceptualization -> schema induction -> final KG.
"""
import asyncio
import json
import time
from collections import Counter, defaultdict

from pydantic import BaseModel

from atlas_rag.kg_construction.triple_config import ProcessingConfig
from atlas_rag.kg_construction.triple_extraction import TextChunker
from atlas_rag.llm_generator.prompt.triple_extraction_prompt import CONCEPT_INSTRUCTIONS, TRIPLE_INSTRUCTIONS

from . import config, socratic
from .autoschema import parse_concepts, valid_entity_relations, valid_event_entities
from .canonicalize import canonicalize
from .graph import PARTICIPATION, all_metrics, build_graph, edge_relation, graph_json, write_graphml
from .llm import LLMClient
from .metrics import graph_metrics
from .rdf import graph_jsonld
from .parsing import parse_json_list

METHODS = ("autoschema", "socratic", "hybrid")


class PipelineRequest(BaseModel):
    text: str
    lang: str = "en"
    method: str = "hybrid"           # autoschema | socratic | hybrid
    canonicalize: bool = True
    qa_batch_size: int = 1           # QA pairs per triple-extraction call (paper: 1)
    chunk_size: int = 4000
    chunk_overlap: int = 0
    concurrency: int = config.LLM_CONCURRENCY
    max_concept_nodes: int = 150
    conceptualize: bool = True
    max_tokens: int = config.LLM_MAX_TOKENS


def ev(type_: str, **data) -> str:
    return json.dumps({"type": type_, "ts": time.time(), **data}, default=list) + "\n"


async def run_pipeline(req: PipelineRequest, llm: LLMClient):
    lang = req.lang if req.lang in TRIPLE_INSTRUCTIONS else "en"
    tp = TRIPLE_INSTRUCTIONS[lang]
    cp = CONCEPT_INSTRUCTIONS[lang]
    method = req.method if req.method in METHODS else "hybrid"
    use_auto = method in ("autoschema", "hybrid")
    use_socratic = method in ("socratic", "hybrid")
    methods = [m for m, on in (("autoschema", use_auto), ("socratic", use_socratic)) if on]
    sem = asyncio.Semaphore(max(1, req.concurrency))
    queue: asyncio.Queue = asyncio.Queue()
    run_id = time.strftime("%Y%m%d-%H%M%S")

    async def call(prompt: str, system: str | None, meta: dict, max_tokens: int | None = None):
        async with sem:
            call_id = f"{meta['stage']}-{meta.get('key', '')}"
            await queue.put(ev("llm_start", call_id=call_id, **meta))
            t0 = time.time()
            try:
                out = await llm.generate(prompt, system, max_tokens or req.max_tokens)
                await queue.put(ev("llm_end", call_id=call_id, ok=True,
                                   seconds=round(time.time() - t0, 2), chars=len(out), **meta))
                return out, None
            except Exception as e:
                msg = f"{type(e).__name__}: {e}"
                await queue.put(ev("llm_end", call_id=call_id, ok=False, error=msg,
                                   seconds=round(time.time() - t0, 2), **meta))
                return "", msg

    async def drain():
        while not queue.empty():
            yield queue.get_nowait()

    async def gather_streaming(coros):
        """Run coroutines concurrently while yielding queued progress events."""
        tasks = [asyncio.ensure_future(c) for c in coros]
        pending = set(tasks)
        try:
            while pending:
                done, pending = await asyncio.wait(pending, timeout=0.25)
                async for e in drain():
                    yield e
            async for e in drain():
                yield e
            for t in tasks:
                if t.exception():
                    raise t.exception()
        finally:
            for t in tasks:
                t.cancel()

    yield ev("run_info", method=method, methods=methods, canonicalize=req.canonicalize, run_id=run_id)

    # ---------- Step 1: chunking -------------------------------------------------
    yield ev("step", step="chunk", status="running")
    cfg = ProcessingConfig(model_path=llm.model, data_directory="", filename_pattern="",
                           chunk_size=req.chunk_size, chunk_overlap=req.chunk_overlap)
    chunks = [c for c in TextChunker(cfg).split_text(req.text) if c.strip()]
    if not chunks:
        yield ev("error", message="No text to process.")
        return
    yield ev("chunks", chunks=[{"id": i, "text": c, "chars": len(c)} for i, c in enumerate(chunks)])
    yield ev("step", step="chunk", status="done", summary=f"{len(chunks)} chunk(s)")

    records: list[dict] = []  # every raw triple with provenance, from every extractor

    # ---------- Step 2: SocraticKG 5W1H QA generation -------------------------------
    qa_pairs: dict[int, list[dict]] = {}
    if use_socratic:
        yield ev("step", step="qa", status="running")

        async def qa_one(ci: int):
            prompt = socratic.qa_generation_prompt(chunks[ci])
            raw, err = await call(prompt, None, {"stage": "qa", "key": str(ci), "chunk": ci},
                                  max_tokens=max(req.max_tokens, 8192))
            pairs = socratic.parse_qa_pairs(raw)
            for i, p in enumerate(pairs):
                p["id"] = f"{ci}.{i}"
            qa_pairs[ci] = pairs
            await queue.put(ev("qa", chunk=ci, prompt=prompt, raw=raw, pairs=pairs, error=err))

        async for e in gather_streaming(qa_one(ci) for ci in range(len(chunks))):
            yield e
        n_qa = sum(len(v) for v in qa_pairs.values())
        wh = Counter(p["wh"] for v in qa_pairs.values() for p in v)
        yield ev("step", step="qa", status="done",
                 summary=f"{n_qa} QA pairs · " + " ".join(f"{k}:{v}" for k, v in wh.most_common(3)))
    else:
        yield ev("step", step="qa", status="skipped", summary="AutoSchemaKG-only run")

    # ---------- Step 3: triple extraction (AutoSchemaKG passes + SocraticKG QA→triples) ----
    yield ev("step", step="extract", status="running")
    kinds = ["entity_relation", "event_entity", "event_relation"]
    n_auto = n_soc = 0

    async def extract_one(ci: int, kind: str):
        nonlocal n_auto
        prompt = tp[kind] + "\n" + chunks[ci]
        raw, err = await call(prompt, tp["system"],
                              {"stage": "extract", "key": f"{ci}-{kind}", "chunk": ci, "kind": kind})
        items = parse_json_list(raw)
        if kind == "event_entity":
            parsed, dropped = valid_event_entities(items)
            for t in parsed:
                for ent in t["Entity"]:
                    records.append({"h": t["Event"], "h_type": "event", "r": PARTICIPATION, "t": ent,
                                    "t_type": "entity", "source": "autoschema", "kind": kind, "chunk": ci})
        else:
            parsed, dropped = valid_entity_relations(items)
            typ = "event" if kind == "event_relation" else "entity"
            for t in parsed:
                records.append({"h": t["Head"], "h_type": typ, "r": t["Relation"], "t": t["Tail"],
                                "t_type": typ, "source": "autoschema", "kind": kind, "chunk": ci})
        n_auto += len(parsed)
        await queue.put(ev("extraction", chunk=ci, kind=kind, prompt=prompt, raw=raw,
                           parsed=parsed, dropped=dropped, error=err))

    async def qa_triples_one(ci: int, batch: list[dict]):
        nonlocal n_soc
        prompt = socratic.qa_triple_prompt(batch)
        ids = [p["id"] for p in batch]
        raw, err = await call(prompt, None, {"stage": "qa_triple", "key": "-".join(ids), "chunk": ci,
                                             "qa_ids": ids, "question": batch[0]["question"]})
        valid, dropped = socratic.parse_qa_triples(raw, len(batch))
        for t in valid:
            p = batch[t["qa"]]
            t["qa_id"] = p["id"]
            records.append({"h": t["Head"], "h_type": "entity", "r": t["Relation"], "t": t["Tail"],
                            "t_type": "entity", "source": "socratic", "kind": "qa", "chunk": ci,
                            "qa_id": p["id"], "question": p["question"], "answer": p["answer"]})
        n_soc += len(valid)
        await queue.put(ev("qa_triples", chunk=ci, qa_ids=ids, prompt=prompt, raw=raw,
                           parsed=valid, dropped=dropped, error=err))

    jobs = []
    if use_auto:
        jobs += [extract_one(ci, k) for ci in range(len(chunks)) for k in kinds]
    if use_socratic:
        bs = max(1, req.qa_batch_size)
        for ci, pairs in qa_pairs.items():
            jobs += [qa_triples_one(ci, pairs[i:i + bs]) for i in range(0, len(pairs), bs)]
    async for e in gather_streaming(jobs):
        yield e
    yield ev("step", step="extract", status="done",
             summary=" · ".join(s for s in (f"{n_auto} AutoSchema" if use_auto else "",
                                             f"{n_soc} Socratic" if use_socratic else "") if s) + " triples")

    # ---------- Step 4: canonicalization (KGGen-style cluster-then-refine) ------------
    ent_map: dict = {}
    rel_map: dict = {}
    if req.canonicalize and records:
        yield ev("step", step="canon", status="running")
        ent_names = {}
        for r in records:
            for name, typ in ((r["h"], r["h_type"]), (r["t"], r["t_type"])):
                if typ == "entity":
                    ent_names.setdefault(name.lower(), name)
        rel_names = {}
        for r in records:
            if r["r"] != PARTICIPATION:
                rel_names.setdefault(r["r"].lower(), r["r"])

        async def canon_call(prompt, meta):
            return await call(prompt, None, meta)

        results = {}

        async def run_canon(kind, items):
            results[kind] = await canonicalize(kind, items, canon_call)

        async for e in gather_streaming([run_canon("entity", list(ent_names.values())),
                                         run_canon("relation", list(rel_names.values()))]):
            yield e
        ent_map, rel_map = results["entity"]["mapping"], results["relation"]["mapping"]
        for kind, names in (("entity", ent_names), ("relation", rel_names)):
            r = results[kind]
            after = len({r["mapping"].get(k, v).lower() for k, v in names.items()})
            yield ev("canon", kind=kind, before=len(names), after=after, merges=r["merges"],
                     groups=r["groups"], info=r["info"])
        yield ev("step", step="canon", status="done",
                 summary=f"entities {len(ent_names)}→{len({ent_map.get(k, v).lower() for k, v in ent_names.items()})} · "
                         f"relations {len(rel_names)}→{len({rel_map.get(k, v).lower() for k, v in rel_names.items()})}")
    else:
        yield ev("step", step="canon", status="skipped", summary="disabled" if records else "no triples")

    # ---------- Step 5: graph integration ----------------------------------------------
    yield ev("step", step="graph", status="running")
    G, gstats = build_graph(records, ent_map, rel_map)
    relations = sorted({d["relation"] for _, _, d in G.edges(data=True)})
    metrics = {"after": all_metrics(G, methods)}
    if ent_map or rel_map:
        G_raw, _ = build_graph(records, {}, {})
        metrics["before"] = all_metrics(G_raw, methods)
    yield ev("base_graph", graph=graph_json(G), relations=relations, stats=gstats, metrics=metrics)
    n_ent = sum(1 for _, d in G.nodes(data=True) if d["type"] == "entity")
    n_evt = G.number_of_nodes() - n_ent
    yield ev("step", step="graph", status="done",
             summary=f"{n_ent} entities · {n_evt} events · {G.number_of_edges()} edges")

    # ---------- Step 6: conceptualization (AutoSchemaKG) ----------------------------------
    concept_rows = []  # {node, label, node_type, concepts}
    if req.conceptualize and G.number_of_nodes():
        yield ev("step", step="concept", status="running")
        targets = []
        by_degree = sorted(G.nodes(data=True), key=lambda x: -G.degree(x[0]))
        for key, d in by_degree:
            targets.append(("event" if d["type"] == "event" else "entity", key, d["id"]))
        targets = targets[: req.max_concept_nodes]
        targets += [("relation", r, r) for r in relations if r != PARTICIPATION][: req.max_concept_nodes]
        yield ev("concept_plan", total=len(targets),
                 skipped=max(0, G.number_of_nodes() - req.max_concept_nodes))

        def entity_context(key):
            # Mirrors concept_generation.py: one predecessor + one successor as context.
            parts = []
            preds = list(G.predecessors(key))[:1]
            succs = list(G.successors(key))[:1]
            parts += [f"{G.nodes[p]['id']} {edge_relation(G, p, key)}" for p in preds]
            parts += [f"{edge_relation(G, key, s)} {G.nodes[s]['id']}" for s in succs]
            return ", ".join(parts)

        async def concept_one(node_type, key, label):
            if node_type == "event":
                prompt = cp["event"].replace("[EVENT]", label)
            elif node_type == "entity":
                prompt = cp["entity"].replace("[ENTITY]", label).replace("[CONTEXT]", entity_context(key))
            else:
                prompt = cp["relation"].replace("[RELATION]", label)
            raw, err = await call(prompt, "You are a helpful AI assistant.",
                                  {"stage": "concept", "key": f"{node_type}-{key}", "node_type": node_type, "node": label})
            concepts = parse_concepts(raw, label)
            row = {"node": key, "label": label, "node_type": node_type, "concepts": concepts,
                   "prompt": prompt, "raw": raw, "error": err}
            concept_rows.append(row)
            await queue.put(ev("concept", **row))

        async for e in gather_streaming(concept_one(*t) for t in targets):
            yield e
        yield ev("step", step="concept", status="done",
                 summary=f"{sum(len(r['concepts']) for r in concept_rows)} concept links")
    else:
        yield ev("step", step="concept", status="skipped", summary="disabled")

    # ---------- Step 7: schema induction (concept nodes + has_concept edges) ---------------
    yield ev("step", step="schema", status="running")
    schema = defaultdict(lambda: {"count": 0, "types": Counter(), "instances": []})
    relation_concepts = {}
    for row in concept_rows:
        for c in row["concepts"]:
            s = schema[c.lower()]
            s["name"] = s.get("name", c)
            s["count"] += 1
            s["types"][row["node_type"]] += 1
            if len(s["instances"]) < 25:
                s["instances"].append(row["label"])
        if row["node_type"] == "relation":
            relation_concepts[row["label"]] = row["concepts"]
        elif row["node"] in G:
            G.nodes[row["node"]]["concepts"] = row["concepts"]

    final = G.copy()
    for row in concept_rows:
        if row["node_type"] == "relation":
            continue
        for c in row["concepts"]:
            ckey = "concept::" + c.lower()
            if ckey not in final:
                final.add_node(ckey, id=c, type="concept", chunks=set(), sources=set(), aliases=set())
            final.add_edge(row["node"], ckey, key="has_concept", relation="has_concept", type="Concept",
                           sources=set(), evidence=[], count=1)

    schema_list = sorted(
        ({"name": v["name"], "count": v["count"], "types": dict(v["types"]), "instances": v["instances"]}
         for v in schema.values()),
        key=lambda x: -x["count"],
    )
    yield ev("schema", concepts=schema_list, relation_concepts=relation_concepts)
    yield ev("step", step="schema", status="done", summary=f"{len(schema_list)} unique concepts")

    # ---------- Step 8: final KG + export ----------------------------------------------
    yield ev("step", step="final", status="running")
    out_dir = config.OUTPUT_DIR / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    final_json = graph_json(final, relation_concepts)
    metrics["with_concepts"] = graph_metrics(final, include_types=("entity", "event", "concept"))
    (out_dir / "graph.json").write_text(json.dumps(final_json, indent=2, ensure_ascii=False))
    (out_dir / "extraction.json").write_text(json.dumps(
        {"method": method,
         "chunks": [{"chunk_id": ci, "text": chunks[ci], "qa_pairs": qa_pairs.get(ci, [])} for ci in range(len(chunks))],
         "triples": records,
         "canonical_entities": ent_map, "canonical_relations": rel_map},
        indent=2, ensure_ascii=False))
    (out_dir / "concepts.json").write_text(json.dumps(
        [{k: r[k] for k in ("label", "node_type", "concepts")} for r in concept_rows], indent=2, ensure_ascii=False))
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))
    write_graphml(final, relation_concepts, out_dir / "graph.graphml")
    (out_dir / "graph.jsonld").write_text(json.dumps(
        graph_jsonld(final, relation_concepts, config.RDF_BASE_IRI), indent=2, ensure_ascii=False))

    try:
        shown_dir = str(out_dir.relative_to(config.REPO_ROOT))
    except ValueError:
        shown_dir = str(out_dir)
    yield ev("final_graph", graph=final_json, run_id=run_id, metrics=metrics, output_dir=shown_dir)
    yield ev("step", step="final", status="done",
             summary=f"{final.number_of_nodes()} nodes · {final.number_of_edges()} edges")
    yield ev("done")
