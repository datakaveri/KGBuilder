"""The JSON-LD export must be valid RDF that keeps the graph, its provenance, and the concept layer."""
import json

import pytest
from rdflib import RDF, RDFS, SKOS, Graph, Literal, Namespace

from kgstudio import config
from kgstudio.pipeline import PipelineRequest, run_pipeline
from kgstudio.rdf import _Slugs

TEXT = "Metformin is a drug. The FDA approved it in 1994. Dr. Sarah Chen led a trial at Johns Hopkins."
NODE, REL, KG, CONCEPT = (Namespace(f"urn:kgstudio:{p}:") for p in ("node", "rel", "vocab", "concept"))


@pytest.fixture
async def rdf_graph(fake_llm):
    events = [json.loads(line) async for line in run_pipeline(PipelineRequest(text=TEXT, method="hybrid"), fake_llm)]
    run_id = next(e for e in events if e["type"] == "final_graph")["run_id"]
    return Graph().parse(config.OUTPUT_DIR / run_id / "graph.jsonld", format="json-ld")


async def test_facts_are_plain_triples(rdf_graph):
    fda, metformin = NODE.food_and_drug_administration, NODE.metformin
    assert (fda, REL.approved, metformin) in rdf_graph
    assert (fda, RDF.type, KG.Entity) in rdf_graph
    assert (fda, RDFS.label, Literal("Food and Drug Administration")) in rdf_graph
    assert (fda, SKOS.altLabel, Literal("FDA")) in rdf_graph
    assert (REL.approved, RDF.type, RDF.Property) in rdf_graph


async def test_statements_carry_provenance(rdf_graph):
    stmt = next(rdf_graph.subjects(RDF.predicate, REL.approved))
    assert (stmt, RDF.type, RDF.Statement) in rdf_graph
    assert set(rdf_graph.objects(stmt, KG.extractedBy)) == {Literal("autoschema"), Literal("socratic")}
    assert rdf_graph.value(stmt, KG["count"])  # KG.count would be str.count.toPython() == 2
    questions = {rdf_graph.value(ev, KG.question) for ev in rdf_graph.objects(stmt, KG.evidence)}
    assert Literal("Who approved metformin?") in questions


async def test_concepts_are_skos(rdf_graph):
    assert (NODE.metformin, KG.hasConcept, CONCEPT.drug) in rdf_graph
    assert (CONCEPT.drug, RDF.type, SKOS.Concept) in rdf_graph


def test_slugs_never_collide():
    slug = _Slugs()
    assert [slug("Type 2 Diabetes"), slug("type-2 diabetes"), slug("Type 2 Diabetes")] == \
        ["type_2_diabetes", "type_2_diabetes_2", "type_2_diabetes"]
