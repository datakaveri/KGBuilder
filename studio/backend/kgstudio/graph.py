"""Graph integration: merge raw triple records from every extractor into one evidence-carrying multigraph."""
import json
from pathlib import Path

import networkx as nx

from .metrics import graph_metrics

PARTICIPATION = "is participated by"
MAX_EVIDENCE = 6


def build_graph(records: list[dict], ent_map: dict, rel_map: dict) -> tuple[nx.MultiDiGraph, dict]:
    """
    Integrate raw triple records into one MultiDiGraph. Entities/relations are mapped to their
    canonical forms; identical (head, relation, tail) facts from different extractors are merged
    and keep every source + evidence. Parallel edges with different relations are preserved.
    """
    G = nx.MultiDiGraph()
    stats = {"self_loops": 0, "merged_duplicates": 0}

    def node(name: str, kind: str, rec: dict):
        canon = ent_map.get(name.lower(), name) if kind == "entity" else name
        key = canon.lower()
        if key not in G:
            G.add_node(key, id=canon, type=kind, chunks=set(), sources=set(), aliases=set())
        elif kind == "event" and G.nodes[key]["type"] == "entity":
            G.nodes[key]["type"] = "event"
        d = G.nodes[key]
        d["chunks"].add(rec["chunk"])
        d["sources"].add(rec["source"])
        if name != canon:
            d["aliases"].add(name)
        return key

    for rec in records:
        a = node(rec["h"], rec["h_type"], rec)
        b = node(rec["t"], rec["t_type"], rec)
        rel = rec["r"] if rec["r"] == PARTICIPATION else rel_map.get(rec["r"].lower(), rec["r"])
        if a == b:
            stats["self_loops"] += 1
            continue
        k = rel.lower()
        ev = {k2: v for k2, v in rec.items() if k2 in ("source", "kind", "chunk", "question", "answer", "qa_id")}
        ev["original"] = f'{rec["h"]} | {rec["r"]} | {rec["t"]}'
        if G.has_edge(a, b, key=k):
            d = G[a][b][k]
            d["sources"].add(rec["source"])
            d["count"] += 1
            if len(d["evidence"]) < MAX_EVIDENCE:
                d["evidence"].append(ev)
            stats["merged_duplicates"] += 1
        else:
            G.add_edge(a, b, key=k, relation=rel, type="Relation", sources={rec["source"]}, evidence=[ev], count=1)
    return G, stats


def graph_json(g: nx.MultiDiGraph, relation_concepts: dict | None = None) -> dict:
    relation_concepts = relation_concepts or {}
    return {
        "nodes": [{"id": k, "label": d["id"], "type": d["type"],
                   "chunks": sorted(d.get("chunks", [])),
                   "sources": sorted(d.get("sources", [])),
                   "aliases": sorted(d.get("aliases", [])),
                   "concepts": d.get("concepts", [])} for k, d in g.nodes(data=True)],
        "edges": [{"source": a, "target": b, "relation": d["relation"], "type": d["type"],
                   "sources": sorted(d.get("sources", [])), "count": d.get("count", 1),
                   "evidence": d.get("evidence", []),
                   "concepts": relation_concepts.get(d["relation"], [])}
                  for a, b, d in g.edges(data=True)],
    }


def edge_relation(G: nx.MultiDiGraph, a, b) -> str:
    return next(iter(G[a][b].values()))["relation"]


def all_metrics(G: nx.MultiDiGraph, methods: list[str]) -> dict:
    out = {"overall": graph_metrics(G)}
    for m in methods:
        out[m] = graph_metrics(G, edge_filter=lambda d, m=m: m in d.get("sources", ()))
    if len(methods) > 1:
        out["both"] = graph_metrics(G, edge_filter=lambda d: len(d.get("sources", ())) > 1)
    return out


def write_graphml(final: nx.MultiDiGraph, relation_concepts: dict, path: Path):
    """GraphML only stores scalars, so flatten set/list/dict attributes first."""
    gml = final.copy()
    for _, d in gml.nodes(data=True):
        d["chunks"] = ",".join(map(str, sorted(d.get("chunks", []))))
        d["concepts"] = ", ".join(d.get("concepts", []))
        d["sources"] = ",".join(sorted(d.get("sources", [])))
        d["aliases"] = " | ".join(sorted(d.get("aliases", [])))
    for _, _, d in gml.edges(data=True):
        d["concepts"] = ", ".join(relation_concepts.get(d["relation"], []))
        d["sources"] = ",".join(sorted(d.get("sources", [])))
        d["evidence"] = json.dumps(d.get("evidence", []), ensure_ascii=False)
    nx.write_graphml(gml, path)
