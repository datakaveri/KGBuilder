from kgstudio import socratic
from kgstudio.autoschema import parse_concepts, valid_entity_relations, valid_event_entities
from kgstudio.llm import extract_text
from kgstudio.parsing import parse_json_list


def test_parse_json_list_handles_fences_prose_and_wrappers():
    assert parse_json_list('Sure!\n```json\n[{"a": 1}]\n```') == [{"a": 1}]
    assert parse_json_list('{"triples": [{"a": 1}, {"a": 2}]}') == [{"a": 1}, {"a": 2}]
    assert parse_json_list('[{"a": 1}, {"a": 2') == [{"a": 1}, {"a": 2}]  # truncated reply is repaired
    assert parse_json_list("no json here") == []


def test_autoschema_validators_count_dropped_items():
    ok, dropped = valid_entity_relations([{"Head": "A", "Relation": "r", "Tail": "B"}, {"Head": "", "Relation": "r"}])
    assert ok == [{"Head": "A", "Relation": "r", "Tail": "B"}] and dropped == 1
    ok, dropped = valid_event_entities([{"Event": "E happened", "Entity": "X"}, {"Event": "F", "Entity": ["..."]}])
    assert ok == [{"Event": "E happened", "Entity": ["X"]}] and dropped == 1


def test_parse_concepts_strips_prefix_dupes_and_self():
    assert parse_concepts("Your answer: drug, Drug, metformin, medication", "Metformin") == ["drug", "medication"]


def test_socratic_qa_pairs_and_wh_types():
    pairs = socratic.parse_qa_pairs('[{"Question": "Why did X rise", "Answer": "Because Y."}, {"q": "", "a": "z"}]')
    assert pairs == [{"question": "Why did X rise?", "answer": "Because Y", "wh": "why"}]
    assert socratic.wh_type("In which year did it happen?") == "other"
    assert socratic.wh_type("How does metformin work?") == "how"


def test_socratic_triples_follow_paper_rules():
    raw = ('[{"entity1": "Metformin", "relation": "treats", "entity2": "diabetes"},'
           ' {"entity1": "it", "relation": "was", "entity2": "1994"},'
           ' {"entity1": "FDA", "relation": "approved its", "entity2": "drug"}]')
    valid, dropped = socratic.parse_qa_triples(raw, 1)
    assert [(t["Head"], t["Relation"], t["Tail"]) for t in valid] == [("Metformin", "treats", "diabetes")]
    assert sorted(d["reason"] for d in dropped) == ["pronoun", "pronoun/clause in relation"]


def test_socratic_batched_prompt_maps_triples_back_to_pairs():
    pairs = [{"question": "Q1?", "answer": "A1"}, {"question": "Q2?", "answer": "A2"}]
    assert "[2]\nQ: Q2?" in socratic.qa_triple_prompt(pairs)
    valid, _ = socratic.parse_qa_triples('[{"qa": 2, "entity1": "X", "relation": "r", "entity2": "Y"}]', 2)
    assert valid[0]["qa"] == 1


def test_extract_text_supports_ollama_and_openai_shapes():
    assert extract_text({"response": "hi"}) == "hi"
    assert extract_text({"choices": [{"message": {"content": "hi"}}]}) == "hi"
    assert extract_text({"message": {"content": "hi"}}) == "hi"
