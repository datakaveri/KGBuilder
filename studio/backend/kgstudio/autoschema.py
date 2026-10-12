"""Parsers for AutoSchemaKG's extraction and conceptualization replies (prompts live in atlas_rag)."""
import re

from .parsing import clean


def valid_entity_relations(items):
    out, dropped = [], 0
    for t in items:
        h, r, tl = clean(t.get("Head")), clean(t.get("Relation")), clean(t.get("Tail"))
        if h and r and tl:
            out.append({"Head": h, "Relation": r, "Tail": tl})
        else:
            dropped += 1
    return out, dropped


def valid_event_entities(items):
    out, dropped = [], 0
    for t in items:
        ev = clean(t.get("Event"))
        ents = t.get("Entity") or []
        if isinstance(ents, str):
            ents = [ents]
        ents = [clean(e) for e in ents if clean(e) and clean(e) != "..."]
        if ev and ents:
            out.append({"Event": ev, "Entity": ents})
        else:
            dropped += 1
    return out, dropped


def parse_concepts(raw: str, original: str) -> list[str]:
    text = raw.strip().splitlines()[0] if raw.strip() else ""
    text = re.sub(r"^(your answer|answer)\s*:\s*", "", text, flags=re.I)
    seen, out = set(), []
    for c in text.split(","):
        c = clean(c).strip("\"'")
        key = c.lower()
        if c and key != original.lower() and key not in seen and len(c) <= 60:
            seen.add(key)
            out.append(c)
    return out[:8]
