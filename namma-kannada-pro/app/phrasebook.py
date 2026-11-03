"""Curated phrasebook, offline fuzzy lookup and Kannada -> Roman transliteration."""
import difflib
import json
import re
import unicodedata
from pathlib import Path

try:
    from indic_transliteration import sanscript
except Exception:  # optional dependency
    sanscript = None

KN_RE = re.compile(r"[\u0C80-\u0CFF]")
DATA = Path(__file__).resolve().parent.parent / "data" / "phrases.json"


class Phrasebook:
    def __init__(self, path=DATA):
        with open(path, encoding="utf-8") as f:
            self.scenarios = json.load(f)["scenarios"]
        self.all = [{**p, "scenario": s["id"]} for s in self.scenarios for p in s["phrases"]]
        self.ids = {s["id"] for s in self.scenarios}

    @staticmethod
    def _norm(t):
        return re.sub(r"[^a-z0-9 ]", "", t.lower()).strip()

    def lookup(self, text, threshold=0.55):
        """Best offline match for an English sentence, or None."""
        q = self._norm(text)
        best, best_score = None, 0.0
        for p in self.all:
            c = self._norm(p["en"])
            score = difflib.SequenceMatcher(None, q, c).ratio()
            qw, cw = set(q.split()), set(c.split())
            if qw and cw:
                score = max(score, 0.9 * len(qw & cw) / max(len(qw), len(cw)))
            if score > best_score:
                best, best_score = p, score
        return best if best_score >= threshold else None


def roman(text):
    """Approximate Roman-letter pronunciation of Kannada script ('' if unavailable)."""
    if sanscript is None or not text or not KN_RE.search(text):
        return ""
    try:
        out = sanscript.transliterate(text, sanscript.KANNADA, sanscript.ITRANS).lower()
        out = "".join(c for c in unicodedata.normalize("NFD", out) if not unicodedata.combining(c))
        return out.replace("~n", "n").replace("^", "")
    except Exception:
        return ""
