"""
Cluster-then-refine canonicalization (KGGen, Mo et al. 2025), as adopted by SocraticKG §3.3:

  1. embed every unique entity / relation string,
  2. K-means into clusters of manageable size,
  3. inside each cluster, rank top-k candidate matches per anchor by dense similarity + BM25,
  4. ask the LLM which candidates are true synonyms / abbreviations and pick a representative.

Entities and relations are canonicalized independently.
"""
import asyncio
import math
import re
from collections import Counter

import numpy as np

from .config import EMBED_MODEL
from .parsing import clean, get_ci, parse_json_list

CANON_PROMPT = """You are canonicalizing the {kind}s of a knowledge graph built from one document.
Below is a list of {kind} names that may contain duplicates written differently.

Group together ONLY names that refer to exactly the same {kind}:
{guidance}
Do NOT group names that are merely related, broader/narrower, or different instances.
For every group with 2 or more members, choose the clearest, most complete name as "representative".
Names that have no duplicate must be left out.

## {KIND} NAMES
{items}

## OUTPUT FORMAT (JSON List)
Return [] if there are no duplicates.
[
{{"representative": "...", "members": ["...", "..."]}}
]"""

GUIDANCE = {
    "entity": "- synonyms, abbreviations and acronyms (e.g. \"TSMC\" = \"Taiwan Semiconductor Manufacturing Company\")\n"
              "- spelling, capitalisation, article (\"the\") and singular/plural variants",
    "relation": "- verb phrases with the same meaning AND the same direction (e.g. \"produces\" = \"manufactures\")\n"
                "- tense, voice-preserving rewording and auxiliary variants (e.g. \"was approved by\" = \"approved by\")\n"
                "- never merge opposites or inverse directions (e.g. \"exports to\" vs \"imports from\")",
}


class Embedder:
    """Sentence-transformer embeddings, falling back to char n-gram TF-IDF if the model can't load."""

    def __init__(self):
        self.model = None
        self.kind = None
        self.error = None

    def load(self):
        if self.kind:
            return
        if EMBED_MODEL.lower() != "tfidf":
            try:
                from sentence_transformers import SentenceTransformer
                self.model = SentenceTransformer(EMBED_MODEL, device="cpu")
                self.kind = EMBED_MODEL
                return
            except Exception as e:  # offline, missing weights, etc.
                self.error = f"{type(e).__name__}: {e}"
        self.kind = "tfidf-char"

    def encode(self, texts: list[str]) -> np.ndarray:
        self.load()
        if self.model is not None:
            return np.asarray(self.model.encode(texts, normalize_embeddings=True, show_progress_bar=False))
        from sklearn.feature_extraction.text import TfidfVectorizer
        X = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 4), lowercase=True).fit_transform(texts)
        X = X.toarray()
        norms = np.linalg.norm(X, axis=1, keepdims=True)
        return X / np.maximum(norms, 1e-9)

    @property
    def threshold(self) -> float:
        # Recall-oriented: the LLM makes the final call, so let borderline pairs through.
        return 0.72 if self.model is not None else 0.5


embedder = Embedder()

_TOKEN = re.compile(r"[a-z0-9]+")
STOP = {"the", "of", "and", "a", "an", "in", "for", "to", "on", "by", "with", "at", "from"}


def _tokens(s: str) -> list[str]:
    return _TOKEN.findall(s.lower())


def _norm(s: str) -> str:
    toks = [t for t in _tokens(s) if t not in {"the", "a", "an"}]
    return " ".join(t[:-1] if len(t) > 3 and t.endswith("s") else t for t in toks)


def _acronym_match(a: str, b: str) -> bool:
    def initials(s):
        return "".join(t[0] for t in _tokens(s) if t not in STOP)
    sa, sb = a.replace(".", "").strip(), b.replace(".", "").strip()
    for short, long in ((sa, sb), (sb, sa)):
        if 2 <= len(short) <= 8 and " " not in short and len(_tokens(long)) >= 2:
            if short.lower() == initials(long) or short.lower() == "".join(t[0] for t in _tokens(long)):
                return True
    return False


def _bm25_matrix(docs: list[list[str]], k1=1.5, b=0.75) -> np.ndarray:
    n = len(docs)
    df = Counter(t for d in docs for t in set(d))
    avgdl = sum(len(d) for d in docs) / max(n, 1) or 1
    idf = {t: math.log(1 + (n - c + 0.5) / (c + 0.5)) for t, c in df.items()}
    M = np.zeros((n, n))
    for i, q in enumerate(docs):
        for j, d in enumerate(docs):
            if i == j:
                continue
            tf = Counter(d)
            s = 0.0
            for t in set(q):
                if t in tf:
                    s += idf[t] * tf[t] * (k1 + 1) / (tf[t] + k1 * (1 - b + b * len(d) / avgdl))
            M[i, j] = s
        if M[i].max() > 0:
            M[i] /= M[i].max()
    return M


def candidate_groups(items: list[str], cluster_size=32, top_k=5, max_group=20) -> tuple[list[list[str]], dict]:
    """Steps 1-3: embed, K-means, top-k dense+BM25 candidates, union-find into candidate groups."""
    n = len(items)
    info = {"items": n, "clusters": 0, "embedder": None}
    if n < 2:
        return [], info
    X = embedder.encode(items)
    info["embedder"] = embedder.kind
    k = max(1, math.ceil(n / cluster_size))
    if k > 1:
        from sklearn.cluster import KMeans
        labels = KMeans(n_clusters=k, n_init=4, random_state=0).fit_predict(X)
    else:
        labels = np.zeros(n, dtype=int)
    info["clusters"] = int(len(set(labels)))

    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i, j):
        parent[find(i)] = find(j)

    for c in set(labels):
        idx = [i for i in range(n) if labels[i] == c]
        if len(idx) < 2:
            continue
        sims = X[idx] @ X[idx].T
        bm = _bm25_matrix([_tokens(items[i]) for i in idx])
        score = 0.7 * sims + 0.3 * bm
        for a in range(len(idx)):
            order = [j for j in np.argsort(-score[a]) if j != a][:top_k]
            for j in order:
                ia, ib = items[idx[a]], items[idx[j]]
                if sims[a, j] >= embedder.threshold or _norm(ia) == _norm(ib) or _acronym_match(ia, ib):
                    union(idx[a], idx[j])
    # Acronyms often land in different K-means clusters — check them globally.
    short = [i for i in range(n) if " " not in items[i].strip() and len(items[i]) <= 8]
    for i in short:
        for j in range(n):
            if i != j and _acronym_match(items[i], items[j]):
                union(i, j)

    groups: dict[int, list[str]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(items[i])
    out = []
    for g in groups.values():
        if len(g) < 2:
            continue
        for s in range(0, len(g), max_group):
            part = g[s:s + max_group]
            if len(part) >= 2:
                out.append(part)
    return out, info


def parse_merges(raw: str, group: list[str]) -> list[dict]:
    by_lower = {g.lower(): g for g in group}
    used, merges = set(), []
    for item in parse_json_list(raw):
        members = get_ci(item, "members", "aliases", "group") or []
        if isinstance(members, str):
            members = [members]
        members = [by_lower[clean(m).lower()] for m in members
                   if clean(m).lower() in by_lower and by_lower[clean(m).lower()] not in used]
        rep = clean(get_ci(item, "representative", "canonical", "name"))
        if rep.lower() in by_lower and by_lower[rep.lower()] not in members and by_lower[rep.lower()] not in used:
            members.append(by_lower[rep.lower()])
        members = list(dict.fromkeys(members))
        if len(members) < 2:
            continue
        if not rep:
            rep = max(members, key=len)
        used.update(members)
        merges.append({"canonical": rep, "members": members})
    return merges


async def canonicalize(kind: str, items: list[str], llm_call) -> dict:
    """
    llm_call(prompt, meta) -> (raw, error). Returns {"mapping", "merges", "groups", "info"}.
    mapping maps lowercased original -> canonical surface form.
    """
    loop = asyncio.get_running_loop()
    groups, info = await loop.run_in_executor(None, candidate_groups, items)
    if embedder.error:
        info["embedder_error"] = embedder.error

    async def refine(gi: int, group: list[str]):
        prompt = CANON_PROMPT.format(kind=kind, KIND=kind.upper(), guidance=GUIDANCE[kind],
                                     items="\n".join(f"- {g}" for g in group))
        raw, err = await llm_call(prompt, {"stage": "canon", "key": f"{kind}-{gi}", "kind": kind, "size": len(group)})
        return {"candidates": group, "merges": parse_merges(raw, group), "raw": raw, "error": err}

    results = await asyncio.gather(*(refine(i, g) for i, g in enumerate(groups)))
    mapping, merges = {}, []
    for r in results:
        for m in r["merges"]:
            merges.append(m)
            for mem in m["members"]:
                mapping[mem.lower()] = m["canonical"]
    return {"mapping": mapping, "merges": merges, "groups": results, "info": info}
