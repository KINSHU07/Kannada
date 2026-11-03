import json

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import RateLimiter, TTLCache, create_app, image_mime, parse_llm
from app.phrasebook import Phrasebook, roman
from app.providers import AIRouter, Breaker, Provider, ProviderError


class Stub(Provider):
    """Deterministic fake provider. mode='ok' | 'fail'."""
    def __init__(self, name="stub", mode="ok"):
        super().__init__()
        self.name, self.mode, self.calls = name, mode, 0

    @property
    def configured(self):
        return True

    def _go(self):
        self.calls += 1
        if self.mode == "fail":
            raise RuntimeError("boom")

    async def translate(self, text, src, tgt):
        self._go()
        return {"en>kn": "ನಮಸ್ಕಾರ", "kn>en": "hello"}.get(f"{src}>{tgt}", "x")

    async def chat(self, system, turns):
        self._go()
        return 'Sure! {"reply": "Where to?", "suggestions": ["To MG Road", "How much?", "Please stop"]}'

    async def vision(self, image, mime):
        self._go()
        return "ಬಸ್ ನಿಲ್ದಾಣ"


def make(providers, **kw):
    s = Settings(**kw)
    return TestClient(create_app(s, AIRouter(s, providers), synth=lambda t, l, sl: b"ID3audio"))


@pytest.fixture
def client():
    return make([Stub()])


def test_health_and_headers(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["ai_configured"] is True
    assert "default-src 'self'" in r.headers["content-security-policy"]
    assert r.headers["x-content-type-options"] == "nosniff" and r.headers["x-request-id"]


def test_scenarios(client):
    d = client.get("/api/scenarios").json()["scenarios"]
    assert len(d) == 5 and sum(len(s["phrases"]) for s in d) == 40


def test_translate_ok_and_cache(client):
    r = client.post("/api/translate", json={"text": "hello", "source": "en", "target": "kn"}).json()
    assert r["text"] == "ನಮಸ್ಕಾರ" and r["roman"] and r["cached"] is False
    assert client.post("/api/translate", json={"text": "hello", "source": "en", "target": "kn"}).json()["cached"] is True


@pytest.mark.parametrize("body", [
    {"text": ""}, {"text": "x" * 301}, {"text": "hi", "source": "xx"}, {"text": "hi", "source": "kn", "target": "kn"}, {"text": "   "},
])
def test_translate_validation(client, body):
    assert client.post("/api/translate", json=body).status_code == 422


def test_translate_falls_back_to_phrasebook_when_ai_down():
    c = make([Stub(mode="fail")])
    r = c.post("/api/translate", json={"text": "How much is this?"})
    assert r.status_code == 200 and r.json()["provider"] == "phrasebook"
    assert c.post("/api/translate", json={"text": "quantum chromodynamics"}).status_code == 503


def test_provider_failover_and_breaker():
    bad, good = Stub("bad", "fail"), Stub("good")
    c = make([bad, good])
    for i in range(5):
        r = c.post("/api/translate", json={"text": f"word {i}"})
        assert r.status_code == 200
    assert bad.calls == 3          # breaker opened after 3 failures
    assert good.calls == 5


def test_breaker_unit():
    b = Breaker(threshold=2, cooldown=60)
    b.fail(); assert b.available()
    b.fail(); assert not b.available()


def test_chat_flow(client):
    r = client.post("/api/chat", json={"scenario": "transport", "history": [], "user": None}).json()
    assert r["reply"]["en"] == "Where to?" and r["reply"]["kn"] and len(r["suggestions"]) == 3 and r["user"] is None
    r2 = client.post("/api/chat", json={"scenario": "transport", "history": [{"role": "assistant", "en": "Where to?"}], "user": "ನಮಸ್ಕಾರ"}).json()
    assert r2["user"]["en"] == "hello"
    assert client.post("/api/chat", json={"scenario": "nope"}).status_code == 422
    too_long = [{"role": "user", "en": "a"}] * 13
    assert client.post("/api/chat", json={"scenario": "food", "history": too_long}).status_code == 422


def test_scan(client):
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 50
    r = client.post("/api/scan", files={"file": ("a.png", png, "image/png")}).json()
    assert r["found"] and r["text"] == "ಬಸ್ ನಿಲ್ದಾಣ"
    assert client.post("/api/scan", files={"file": ("a.txt", b"hello", "text/plain")}).status_code == 415
    big = b"\xff\xd8\xff" + b"0" * (5 * 1024 * 1024)
    assert client.post("/api/scan", files={"file": ("a.jpg", big, "image/jpeg")}).status_code == 413


def test_tts(client):
    r = client.get("/api/tts", params={"text": "ನಮಸ್ಕಾರ"})
    assert r.status_code == 200 and r.content == b"ID3audio" and "immutable" in r.headers["cache-control"]
    assert client.get("/api/tts", params={"text": ""}).status_code == 422
    assert client.get("/api/tts", params={"text": "x", "lang": "fr"}).status_code == 422


def test_rate_limit():
    c = make([Stub()], rate_ai_per_min=3)
    codes = [c.post("/api/translate", json={"text": f"w{i}"}).status_code for i in range(5)]
    assert codes == [200, 200, 200, 429, 429]
    assert c.post("/api/translate", json={"text": "w9"}).headers["retry-after"]


def test_no_providers_configured():
    class Off(Stub):
        @property
        def configured(self):
            return False
    c = make([Off()])
    assert c.get("/api/health").json()["ai_configured"] is False
    assert c.post("/api/translate", json={"text": "hello"}).status_code == 503


def test_static_index_served(client):
    assert client.get("/").status_code == 200


def test_helpers():
    assert parse_llm('x {"reply": "Hi", "suggestions": ["a","b","c","d"]}') == ("Hi", ["a", "b", "c"])
    assert parse_llm("plain text") == ("plain text", [])
    assert image_mime(b"RIFF\0\0\0\0WEBPx") == "image/webp" and image_mime(b"nope") is None
    c = TTLCache(2, 60); c.set("a", 1); c.set("b", 2); c.set("c", 3)
    assert c.get("a") is None and c.get("c") == 3
    rl = RateLimiter(2); assert rl.check("k") and rl.check("k") and not rl.check("k") and rl.check("other")
    pb = Phrasebook()
    assert pb.lookup("how much is this")["kn"] and pb.lookup("zzzz qqqq") is None
    assert roman("ಇದು ಎಷ್ಟು?") == "idu eshtu?"
