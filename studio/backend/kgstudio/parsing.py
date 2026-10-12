import re

import json_repair


def parse_json_list(raw: str) -> list:
    """Best-effort: find the JSON array in the reply and repair it."""
    text = raw.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    start = text.find("[")
    if start != -1:
        text = text[start:]
    try:
        parsed = json_repair.loads(text)
    except Exception:
        return []
    if isinstance(parsed, dict):
        # e.g. {"triples": [...]} or a single object
        lists = [v for v in parsed.values() if isinstance(v, list)]
        parsed = lists[0] if lists else [parsed]
    return [p for p in parsed if isinstance(p, dict)] if isinstance(parsed, list) else []


def clean(s) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip().strip(".")


def get_ci(d: dict, *keys):
    """Case-insensitive dict lookup over several candidate keys."""
    lower = {str(k).lower(): v for k, v in d.items()}
    for k in keys:
        if k.lower() in lower:
            return lower[k.lower()]
    return None
