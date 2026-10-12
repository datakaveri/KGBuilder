"""Structural metrics from SocraticKG §4.1: triple count, average degree, NFI."""
import networkx as nx


def graph_metrics(G: nx.MultiDiGraph, edge_filter=None, include_types=("entity", "event")) -> dict:
    """
    Deg = 2E/N where E counts unique undirected neighbour pairs; NFI = (C-1)/(N-1) over weakly
    connected components. Only nodes touched by a kept edge count (plus isolated nodes when unfiltered).
    """
    U = nx.Graph()
    triples = 0
    for a, b, d in G.edges(data=True):
        if G.nodes[a].get("type") not in include_types or G.nodes[b].get("type") not in include_types:
            continue
        if edge_filter and not edge_filter(d):
            continue
        triples += 1
        U.add_edge(a, b)
    if edge_filter is None:
        U.add_nodes_from(n for n, d in G.nodes(data=True) if d.get("type") in include_types)
    N, E = U.number_of_nodes(), U.number_of_edges()
    C = nx.number_connected_components(U) if N else 0
    largest = max((len(c) for c in nx.connected_components(U)), default=0)
    return {
        "nodes": N,
        "triples": triples,
        "avg_degree": round(2 * E / N, 3) if N else 0,
        "components": C,
        "nfi": round((C - 1) / (N - 1), 4) if N >= 2 else 0,
        "largest_component": round(largest / N, 4) if N else 0,
    }
