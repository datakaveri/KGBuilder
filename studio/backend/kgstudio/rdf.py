"""
RDF export of the final graph as JSON-LD.

Every fact is emitted twice: as a plain triple on its subject (`node:metformin rel:treats node:type_2_diabetes`),
so any RDF tool sees the graph directly, and as an `rdf:Statement` that carries the provenance RDF triples can't hold
themselves (which extractors found it, how often, and the evidence: chunk, QA pair, original wording).
Instances link to induced concepts (`skos:Concept`) through `kg:hasConcept`; relation-level concepts hang off the
`rdf:Property` declaration of each relation.
"""
import re

import networkx as nx


def _prefixes(base: str) -> dict:
    sep = ":" if base.endswith(":") else "/"
    if not base.endswith((":", "/", "#")):
        base += "/"
    return {"kg": f"{base}vocab{sep}", "node": f"{base}node{sep}",
            "rel": f"{base}rel{sep}", "concept": f"{base}concept{sep}"}


class _Slugs:
    """Stable, collision-free local names: 'Type 2 Diabetes' -> 'type_2_diabetes' (then _2, _3 on clashes)."""

    def __init__(self):
        self.by_key: dict[str, str] = {}
        self.used: set[str] = set()

    def __call__(self, key: str) -> str:
        if key not in self.by_key:
            base = re.sub(r"\W+", "_", key.lower()).strip("_") or "x"
            slug, n = base, 1
            while slug in self.used:
                n += 1
                slug = f"{base}_{n}"
            self.used.add(slug)
            self.by_key[key] = slug
        return self.by_key[key]


def graph_jsonld(final: nx.MultiDiGraph, relation_concepts: dict | None = None,
                 base: str = "urn:kgstudio:") -> dict:
    relation_concepts = relation_concepts or {}
    node_slug, rel_slug, concept_slug = _Slugs(), _Slugs(), _Slugs()

    def iri(key: str) -> str:
        d = final.nodes[key]
        return f"concept:{concept_slug(d['id'].lower())}" if d["type"] == "concept" else f"node:{node_slug(key)}"

    def concept_iri(name: str) -> str:
        return f"concept:{concept_slug(name.lower())}"

    nodes: dict[str, dict] = {}
    for key, d in final.nodes(data=True):
        obj = {"@id": iri(key), "@type": {"entity": "Entity", "event": "Event", "concept": "Concept"}[d["type"]],
               "label": d["id"]}
        if d.get("aliases"):
            obj["altLabel"] = sorted(d["aliases"])
        if d.get("sources"):
            obj["extractedBy"] = sorted(d["sources"])
        if d.get("chunks"):
            obj["chunk"] = sorted(d["chunks"])
        nodes[key] = obj

    properties: dict[str, dict] = {}
    statements: list[dict] = []
    for a, b, d in final.edges(data=True):
        subj, obj = nodes[a], nodes[b]
        if d["type"] == "Concept":
            subj.setdefault("hasConcept", []).append(obj["@id"])
            continue
        rel = d["relation"]
        pred = f"rel:{rel_slug(rel)}"
        if pred not in properties:
            properties[pred] = {"@id": pred, "@type": "rdf:Property", "label": rel}
            if relation_concepts.get(rel):
                properties[pred]["hasConcept"] = [concept_iri(c) for c in relation_concepts[rel]]
        subj.setdefault(pred, []).append({"@id": obj["@id"]})
        evidence = []
        for ev in d.get("evidence", []):
            e = {"@type": "Evidence", "extractedBy": ev["source"], "chunk": ev["chunk"], "extractionKind": ev["kind"],
                 "originalTriple": ev["original"]}
            if ev.get("question"):
                e["question"], e["answer"] = ev["question"], ev.get("answer", "")
            evidence.append(e)
        statements.append({"@type": "rdf:Statement", "subject": subj["@id"], "predicate": pred, "object": obj["@id"],
                           "extractedBy": sorted(d.get("sources", [])), "count": d.get("count", 1),
                           "evidence": evidence})

    # Relation concepts may name concepts no instance has; declare them so every IRI resolves.
    declared = {n["@id"] for n in nodes.values() if n["@type"] == "Concept"}
    extra = []
    for names in relation_concepts.values():
        for name in names:
            c = concept_iri(name)
            if c not in declared:
                declared.add(c)
                extra.append({"@id": c, "@type": "Concept", "label": name})

    p = _prefixes(base)
    context = {
        "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
        "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
        "skos": "http://www.w3.org/2004/02/skos/core#",
        "xsd": "http://www.w3.org/2001/XMLSchema#",
        **p,
        "Entity": "kg:Entity",
        "Event": "kg:Event",
        "Concept": "skos:Concept",
        "Evidence": "kg:Evidence",
        "label": "rdfs:label",
        "altLabel": "skos:altLabel",
        "hasConcept": {"@id": "kg:hasConcept", "@type": "@id"},
        "extractedBy": "kg:extractedBy",
        "chunk": {"@id": "kg:chunk", "@type": "xsd:integer"},
        "count": {"@id": "kg:count", "@type": "xsd:integer"},
        "extractionKind": "kg:extractionKind",
        "originalTriple": "kg:originalTriple",
        "question": "kg:question",
        "answer": "kg:answer",
        "evidence": "kg:evidence",
        "subject": {"@id": "rdf:subject", "@type": "@id"},
        "predicate": {"@id": "rdf:predicate", "@type": "@id"},
        "object": {"@id": "rdf:object", "@type": "@id"},
    }
    return {"@context": context, "@graph": [*nodes.values(), *extra, *properties.values(), *statements]}
