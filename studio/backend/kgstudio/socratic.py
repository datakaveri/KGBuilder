"""
SocraticKG: Knowledge Graph Construction via QA-Driven Fact Extraction
(Choi et al., Findings of ACL 2026, https://aclanthology.org/2026.findings-acl.1951).

Stage 1: 5W1H-guided QA generation (Appendix B.1, Role-Oriented w/ 5W1H) turns a document into
         self-contained question-answer pairs with pronouns resolved.
Stage 2: Triple extraction from QA (Appendix C.1) maps each QA pair to atomic triples.
Stage 3: Canonicalization (see studio/canonicalize.py) merges surface-form variants.
"""
import re

from .parsing import clean, get_ci, parse_json_list

# Appendix B.1 — verbatim (the paper's {{ }} are str.format escapes; we substitute manually).
QA_GENERATION_PROMPT = """## ROLE
You are a **Comprehensive Knowledge Archivist** who converts the [Full Document] into detailed,
document-grounded QA pairs.
## OBJECTIVE
Extract as many meaningful Question-Answer pairs as possible from the document.
Use the 5W1H perspectives (Who, What, When, Where, Why, How) **as analytical lenses** to help you
identify and expand potential questions, but do NOT restrict yourself to producing only
5W1H-type questions.
Your goal is to maximize informational coverage, capturing every explicit fact, relation, event,
definition, rationale, and process described in the document.
## INPUT
Full Document: "{document_text}"
## CONSTRAINTS
1. **Context-Independent**
- Each QA must be self-contained and understandable without referencing the original text.
- Replace pronouns with explicit entities.
2. **No Hallucination**
- Use only facts explicitly stated in the document.
3. **Expansion-Oriented Thinking**
- For each sentence or factual unit, consider the 5W1H perspectives as prompts to explore:
- WHO is involved?
- WHAT happened or is described?
- WHEN did it occur?
- WHERE did it occur?
- WHY did it occur?
- HOW was it carried out?
- These perspectives are **guides** to inspire multiple possible QA pairs, even if they are
implicit or only partially expressed.
4. **Coverage**
- Extract all possible QA pairs that can be reasonably derived from the document.
## OUTPUT FORMAT
Return a JSON list of QA objects:
[
{"question": "...", "answer": "..."},
...
]"""

# Appendix C.1 — verbatim rules; INPUT block is filled per QA pair.
_TRIPLE_RULES = """## ROLE
You are a Semantic Knowledge Graph Builder.
Extract every structured triples (entity1, relation, entity2) from the Q&A pair, following the
rules below.
## GOAL
From the question-answer pair, extract only useful, knowledge-ready triples that can serve as
entries in a semantic knowledge graph.
## RULES
Extract clean (subject, relation, object) triples following the rules:
1. Split every stated or clearly implied fact into minimal triples; integrate question and answer
context when needed.
2. Entities (entity1, entity2) must be short, concrete noun phrases.
- No pronouns (this, that, it, its, these, those, etc.).
- Entities must not be unresolved or reference-based pronouns (e.g. those, they, someone,
anyone, whoever); if such a pronoun appears, rewrite it into a specific, explicit noun phrase
or skip the triple.
- No clauses or relative clauses (no "who/that/which/what/as it ..." inside an entity).
- No long gerund or sentence-like phrases. If a phrase contains a verb or clause marker,
rewrite it into a concise noun concept or skip the triple.
3. Relations must be short, canonical verbs or verb phrases.
- Express a single semantic link between the two entities (e.g. causes, leads to, supports,
believes, opposes).
- Must be a compact predicate, not a sentence fragment.
- No pronouns or clause markers inside the relation (no "its", "that", "as it", "what", etc.).
- If the source uses an idiomatic or long expression, rewrite it into a simple canonical
relation without pronouns or embedded clauses, or skip the triple.
4. Include a fact if it can be clearly rewritten into a concise, explicit triple that fits the
rules above; otherwise skip it.
5. Output only concise, interpretable, knowledge-ready triples."""

QA_TRIPLE_PROMPT = _TRIPLE_RULES + """
## INPUT
Q: {question}
A: {answer}
## OUTPUT FORMAT (JSON List)
- Return a list of JSON objects.
- Return [] if no valid triples exist.
[
{"entity1": "Specific_Noun", "relation": "precise_verb_phrase", "entity2": "Specific_Noun"}
]"""

# Batched variant (our extension, off by default): several QA pairs per call to save round-trips.
QA_TRIPLE_BATCH_PROMPT = _TRIPLE_RULES + """
6. Treat every numbered Q&A pair as an independent unit and record its number in "qa".
## INPUT
{pairs}
## OUTPUT FORMAT (JSON List)
- Return a list of JSON objects.
- Return [] if no valid triples exist.
[
{"qa": 1, "entity1": "Specific_Noun", "relation": "precise_verb_phrase", "entity2": "Specific_Noun"}
]"""

PRONOUNS = {
    "it", "its", "this", "that", "these", "those", "they", "them", "their", "he", "she", "him", "her",
    "his", "hers", "we", "us", "our", "you", "your", "i", "me", "my", "someone", "anyone", "whoever",
    "something", "anything", "everyone", "somebody", "anybody", "which", "who", "what",
}
CLAUSE_MARKERS = re.compile(r"\b(who|which|that|what|as it)\b", re.I)

WH_TYPES = ("who", "what", "when", "where", "why", "how")


def qa_generation_prompt(document_text: str) -> str:
    return QA_GENERATION_PROMPT.replace("{document_text}", document_text)


def qa_triple_prompt(pairs: list[dict]) -> str:
    if len(pairs) == 1:
        return QA_TRIPLE_PROMPT.replace("{question}", pairs[0]["question"]).replace("{answer}", pairs[0]["answer"])
    block = "\n\n".join(f"[{i + 1}]\nQ: {p['question']}\nA: {p['answer']}" for i, p in enumerate(pairs))
    return QA_TRIPLE_BATCH_PROMPT.replace("{pairs}", block)


def wh_type(question: str) -> str:
    """Classify a question by its leading interrogative (for display only)."""
    q = question.strip().lower()
    for w in WH_TYPES:
        if q.startswith(w) or re.match(rf"^(in|on|at|by|for|to|from|with) {w}\b", q):
            return w
    for w in WH_TYPES:
        if re.search(rf"\b{w}\b", q):
            return w
    return "other"


def parse_qa_pairs(raw: str) -> list[dict]:
    out, seen = [], set()
    for item in parse_json_list(raw):
        q = clean(get_ci(item, "question", "q"))
        a = clean(get_ci(item, "answer", "a"))
        if q and a and (q.lower(), a.lower()) not in seen:
            seen.add((q.lower(), a.lower()))
            out.append({"question": q if q.endswith("?") else q + "?", "answer": a, "wh": wh_type(q)})
    return out


def _bad_entity(e: str) -> str | None:
    words = e.lower().split()
    if not words:
        return "empty"
    if e.lower() in PRONOUNS or (len(words) <= 2 and words[0] in PRONOUNS):
        return "pronoun"
    if len(words) > 12:
        return "sentence-like"
    return None


def parse_qa_triples(raw: str, n_pairs: int) -> tuple[list[dict], list[dict]]:
    """Returns (valid triples with 'qa' index, dropped items with a reason)."""
    valid, dropped = [], []
    for item in parse_json_list(raw):
        h = clean(get_ci(item, "entity1", "head", "subject"))
        r = clean(get_ci(item, "relation", "predicate"))
        t = clean(get_ci(item, "entity2", "tail", "object"))
        qa = get_ci(item, "qa")
        try:
            qa = int(qa) - 1 if n_pairs > 1 else 0
        except (TypeError, ValueError):
            qa = 0
        qa = min(max(qa, 0), n_pairs - 1)
        reason = None
        if not (h and r and t):
            reason = "missing field"
        else:
            reason = _bad_entity(h) or _bad_entity(t)
            if not reason and (set(r.lower().split()) & {"its", "it", "that", "what"}):
                reason = "pronoun/clause in relation"
            if not reason and h.lower() == t.lower():
                reason = "self-loop"
        if reason:
            dropped.append({"item": {"Head": h, "Relation": r, "Tail": t}, "reason": reason})
        else:
            valid.append({"Head": h, "Relation": r, "Tail": t, "qa": qa})
    return valid, dropped
