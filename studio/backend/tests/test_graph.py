import json

import networkx as nx

from kgstudio import canonicalize
from kgstudio.graph import build_graph, write_graphml
from kgstudio.metrics import graph_metrics


def rec(h, r, t, source="autoschema", **kw):
    return {"h": h, "h_type": "entity", "r": r, "t": t, "t_type": "entity", "source": source, "kind": "x",
            "chunk": 0, **kw}


def test_build_graph_merges_sources_keeps_parallel_edges_and_drops_self_loops():
    records = [
        rec("FDA", "approved", "Metformin"),
        rec("Food and Drug Administration", "approved", "metformin", source="socratic", question="Q?", answer="A"),
        rec("FDA", "regulates", "Metformin"),
        rec("X", "is", "x"),
    ]
    G, stats = build_graph(records, {"fda": "Food and Drug Administration"}, {})
    assert stats == {"self_loops": 1, "merged_duplicates": 1}
    edges = {d["relation"]: d for _, _, d in G.edges(data=True)}
    assert set(edges) == {"approved", "regulates"}  # parallel relations both survive
    assert edges["approved"]["sources"] == {"autoschema", "socratic"} and edges["approved"]["count"] == 2
    assert G.nodes["food and drug administration"]["aliases"] == {"FDA"}


def test_metrics_match_paper_definitions():
    G = nx.MultiDiGraph()
    for n in "abcde":
        G.add_node(n, type="entity")
    G.add_edge("a", "b", sources={"autoschema"})
    G.add_edge("b", "a", sources={"socratic"})  # same undirected neighbour pair
    G.add_edge("c", "d", sources={"socratic"})
    m = graph_metrics(G)
    # N=5, unique undirected pairs E=2 -> Deg=2E/N=0.8; components C=3 -> NFI=(3-1)/(5-1)=0.5
    assert m["triples"] == 3 and m["avg_degree"] == 0.8 and m["components"] == 3 and m["nfi"] == 0.5
    assert graph_metrics(G, edge_filter=lambda d: "socratic" in d["sources"])["triples"] == 2


def test_graphml_export_roundtrips(tmp_path):
    G, _ = build_graph([rec("A", "r", "B", question="Q?", answer="Ans")], {}, {})
    write_graphml(G, {}, tmp_path / "g.graphml")
    H = nx.read_graphml(tmp_path / "g.graphml")
    (_, _, d), = H.edges(data=True)
    assert json.loads(d["evidence"])[0]["question"] == "Q?"


def test_candidate_groups_find_acronyms_and_variants():
    groups, info = canonicalize.candidate_groups(
        ["FDA", "Food and Drug Administration", "liver", "guidelines", "guideline", "Barcelona"])
    flat = [set(g) for g in groups]
    assert {"FDA", "Food and Drug Administration"} in flat
    assert any({"guidelines", "guideline"} <= g for g in flat)
    assert info["embedder"] == "tfidf-char"


def test_parse_merges_only_accepts_known_members():
    merges = canonicalize.parse_merges(
        '[{"representative": "Food and Drug Administration", "members": ["FDA", "Food and Drug Administration", "made up"]}]',
        ["FDA", "Food and Drug Administration"])
    assert merges == [{"canonical": "Food and Drug Administration", "members": ["FDA", "Food and Drug Administration"]}]
