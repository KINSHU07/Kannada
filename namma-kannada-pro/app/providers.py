"""AI provider abstraction: Gemini + Hugging Face behind one router.

Every provider implements translate / chat / vision. The router tries providers in the
configured order, enforces a timeout, and uses a circuit breaker so a failing provider is
skipped for a cool-down period instead of slowing every request.
"""
import asyncio
import base64
import json
import logging
import re
import time

import httpx

LANGS = {  # code -> (NLLB code, English name)
    "en": ("eng_Latn", "English"), "kn": ("kan_Knda", "Kannada"), "hi": ("hin_Deva", "Hindi"),
    "ta": ("tam_Taml", "Tamil"), "te": ("tel_Telu", "Telugu"), "ml": ("mal_Mlym", "Malayalam"),
}
VISION_PROMPT = ("Transcribe all Kannada text visible in this image exactly as written, one line per line. "
                 "If there is no Kannada text, reply NONE. Output only the text.")


log = logging.getLogger("nk")


class ProviderError(Exception):
    pass


class Unsupported(ProviderError):
    """No configured provider implements the requested operation."""


HINTS = {402: "out of free credits (Hugging Face): wait for the monthly reset or use Gemini", 400: "bad request (check the model name)", 401: "invalid API key", 403: "key not allowed or API not enabled",
         404: "model not found (set GEMINI_MODEL or the HF_*_MODEL variable)", 429: "rate limit or quota exceeded",
         500: "provider error", 503: "provider overloaded"}


def describe(exc):
    """Short, key-free, human-readable reason for a provider failure."""
    resp = getattr(exc, "response", None)
    status = getattr(resp, "status_code", None)
    out = type(exc).__name__
    if status:
        out += f" HTTP {status}: {HINTS.get(status, 'error')}"
        try:
            out += f" - {str(resp.json()['error']['message'])[:140]}"
        except Exception:
            pass
    else:
        out += f": {str(exc)[:120] or 'no details (timeout or network)'}"
    if "not supported by any provider" in str(exc) or "no inference provider" in str(exc):
        out += " | Fix: enable providers at huggingface.co/settings/inference-providers, or use a Gemini key"
    return out


class Breaker:
    def __init__(self, threshold=3, cooldown=30):
        self.threshold, self.cooldown, self.fails, self.open_until = threshold, cooldown, 0, 0.0

    def available(self):
        return time.monotonic() >= self.open_until

    def ok(self):
        self.fails = 0

    def fail(self):
        self.fails += 1
        if self.fails >= self.threshold:
            self.open_until, self.fails = time.monotonic() + self.cooldown, 0


class Provider:
    name = "base"

    def __init__(self):
        self.breaker = Breaker()

    @property
    def configured(self):
        return False

    def available(self):
        return self.configured and self.breaker.available()


RETRYABLE = (404, 429, 500, 502, 503, 504)


class GeminiProvider(Provider):
    """Google Gemini. Models get retired or overloaded, so a failing model (404/429/5xx/timeout)
    makes the provider ask the API which flash models exist and try the next-best ones."""
    name = "gemini"
    BASE = "https://generativelanguage.googleapis.com/v1beta"
    ATTEMPT_TIMEOUT = 10

    def __init__(self, s):
        super().__init__()
        self.key, self.model = s.gemini_key, s.gemini_model
        self.client = httpx.AsyncClient(timeout=self.ATTEMPT_TIMEOUT)
        self.ranked = None

    @property
    def configured(self):
        return bool(self.key)

    @property
    def picked(self):
        return self.model

    async def _discover(self):
        """Usable flash models for this key, newest stable first."""
        r = await self.client.get(f"{self.BASE}/models?pageSize=200", headers={"x-goog-api-key": self.key})
        r.raise_for_status()
        names = [m["name"].split("/", 1)[-1] for m in r.json().get("models", [])
                 if "generateContent" in m.get("supportedGenerationMethods", [])]
        skip = ("image", "tts", "live", "audio", "embed", "robotics", "computer", "thinking", "learnlm")

        def rank(n):
            v = re.search(r"gemini-(\d+(?:\.\d+)?)-flash(-lite)?(?!\w)", n)
            unstable = any(x in n for x in ("preview", "exp"))
            return (not unstable, float(v.group(1)) if v else -1, not (v and v.group(2)))

        return sorted([n for n in names if "flash" in n and not any(x in n for x in skip)], key=rank, reverse=True)

    async def _call(self, contents, system=None, json_mode=True):
        body = {"contents": contents, "generationConfig": {"temperature": 0.3}}
        if json_mode:
            body["generationConfig"]["responseMimeType"] = "application/json"
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        order, i, last = [self.model], 0, None
        while i < len(order):
            model = order[i]
            if i and order[i - 1] == model:
                await asyncio.sleep(1.5)                      # same-model retry after a short pause
            i += 1
            try:
                r = await self.client.post(f"{self.BASE}/models/{model}:generateContent", json=body,
                                           headers={"x-goog-api-key": self.key})
                r.raise_for_status()
                if model != self.model:
                    log.info(json.dumps({"event": "gemini_model_switched", "from": self.model, "to": model}))
                    self.model = model
                return r.json()["candidates"][0]["content"]["parts"][0]["text"]
            except (httpx.HTTPStatusError, httpx.TransportError) as exc:
                last = exc
                status = getattr(getattr(exc, "response", None), "status_code", None)
                if status is not None and status not in RETRYABLE:
                    raise
                if self.ranked is None:
                    try:
                        self.ranked = await self._discover()
                    except Exception:
                        self.ranked = []
                    extra = [m for m in self.ranked if m not in order][:2]
                    order += extra
                    if not extra and status in (429, 503):
                        order.append(model)                  # no alternative model: retry once
        raise last

    async def translate(self, text, src, tgt):
        prompt = (f"Translate from {LANGS[src][1]} to {LANGS[tgt][1]}. Natural, polite, everyday spoken style. "
                  f'Return JSON {{"text": "..."}} only.\n\nText: {text}')
        import json
        out = json.loads(await self._call([{"role": "user", "parts": [{"text": prompt}]}]))
        return str(out["text"]).strip()

    async def chat(self, system, turns):
        contents = [{"role": "user" if t["role"] == "user" else "model", "parts": [{"text": t["content"]}]} for t in turns]
        return await self._call(contents, system)

    async def converse(self, system, turns):
        """One call returns Kannada + English + suggestions (fast path for Talk)."""
        return await self.chat(system, turns)

    async def vision(self, image, mime):
        parts = [{"inline_data": {"mime_type": mime, "data": base64.b64encode(image).decode()}}, {"text": VISION_PROMPT}]
        return (await self._call([{"role": "user", "parts": parts}], json_mode=False)).strip()


PREFERRED_CHAT = ["Qwen/Qwen3-8B", "Qwen/Qwen2.5-7B-Instruct", "meta-llama/Llama-3.1-8B-Instruct",
                  "meta-llama/Llama-3.3-70B-Instruct", "openai/gpt-oss-20b", "openai/gpt-oss-120b", "deepseek-ai/DeepSeek-V3-0324"]


class HFProvider(Provider):
    """Hugging Face Inference Providers. Models change often, so the chat model is discovered
    automatically (unless HF_CHAT_MODEL is set) and translation falls back to the chat model
    when the dedicated translation model is not served for this account."""
    name = "hf"

    def __init__(self, s):
        super().__init__()
        self.s, self.picked, self.mt_ok, self._ids = s, None, None, None

    @property
    def configured(self):
        return bool(self.s.hf_token)

    def _client(self, model=None):
        from huggingface_hub import InferenceClient
        return InferenceClient(model=model, token=self.s.hf_token, timeout=self.s.ai_timeout)

    @staticmethod
    def _unavailable(exc):
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status in (401, 402, 403, 429):
            return False
        msg = str(exc).lower()
        return status in (400, 404) or "provider" in msg or "not supported" in msg or "not found" in msg

    async def _models(self):
        if self._ids is None:
            async with httpx.AsyncClient(timeout=10) as c:
                r = await c.get("https://router.huggingface.co/v1/models", headers={"Authorization": f"Bearer {self.s.hf_token}"})
                r.raise_for_status()
                self._ids = [m["id"] for m in r.json().get("data", [])]
        return self._ids

    async def _candidates(self):
        if self.s.hf_chat_model:
            return [self.s.hf_chat_model]
        if self.picked:
            return [self.picked]
        try:
            ids = await self._models()
        except Exception:
            ids = []
        return ([m for m in PREFERRED_CHAT if m in ids] or PREFERRED_CHAT)[:5]

    async def _llm(self, messages, max_tokens=300, temperature=0.6):
        last = None
        for model in await self._candidates():
            def run(m=model):
                try:
                    r = self._client(m).chat_completion(messages=messages, max_tokens=max_tokens, temperature=temperature)
                except StopIteration:
                    raise RuntimeError(f"no inference provider serves {m}")
                return r.choices[0].message.content or ""
            try:
                out = await asyncio.to_thread(run)
                self.picked = model
                return re.sub(r"<think>.*?</think>", "", out, flags=re.S).strip()
            except Exception as exc:
                last = exc
                if not self._unavailable(exc):
                    raise
        raise last or RuntimeError("no chat model available")

    async def translate(self, text, src, tgt):
        if self.mt_ok is not False:
            def run():
                try:
                    out = self._client().translation(text, model=self.s.hf_mt_model, src_lang=LANGS[src][0], tgt_lang=LANGS[tgt][0])
                except StopIteration:
                    raise RuntimeError("no inference provider serves the translation model")
                return out.translation_text.strip()
            try:
                result = await asyncio.to_thread(run)
                self.mt_ok = True
                return result
            except Exception as exc:
                if self._unavailable(exc):
                    self.mt_ok = False      # stop trying the dedicated model this run
        prompt = (f"Translate from {LANGS[src][1]} to {LANGS[tgt][1]}. Natural, polite, everyday spoken style"
                  f"{', in Kannada script' if tgt == 'kn' else ''}. Return ONLY JSON {{\"text\": \"...\"}}.\n\nText: {text}")
        raw = await self._llm([{"role": "user", "content": prompt}], 200, 0.2)
        return str(json.loads(re.search(r"\{.*\}", raw, re.S).group(0))["text"]).strip()

    async def chat(self, system, turns):
        return await self._llm([{"role": "system", "content": system}] + turns)

    async def converse(self, system, turns):
        return await self.chat(system, turns)

    async def vision(self, image, mime):
        def run():
            url = f"data:{mime};base64,{base64.b64encode(image).decode()}"
            msg = [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": url}}, {"type": "text", "text": VISION_PROMPT}]}]
            try:
                return self._client(self.s.hf_vision_model).chat_completion(messages=msg, max_tokens=400).choices[0].message.content.strip()
            except StopIteration:
                raise RuntimeError("no inference provider serves the vision model")
        return await asyncio.to_thread(run)


class AIRouter:
    def __init__(self, settings, providers=None):
        self.timeout = settings.ai_timeout
        registry = {"gemini": GeminiProvider, "hf": HFProvider}
        self.providers = providers if providers is not None else [registry[n](settings) for n in settings.providers if n in registry]

    @property
    def any_configured(self):
        return any(p.configured for p in self.providers)

    async def run(self, op, *args):
        capable = [p for p in self.providers if hasattr(p, op)]
        if not capable:
            raise Unsupported(f"no provider supports {op}")
        errors = []
        for p in capable:
            if not p.available():
                continue
            try:
                result = await asyncio.wait_for(getattr(p, op)(*args), timeout=self.timeout)
                p.breaker.ok()
                return result, p.name
            except Exception as exc:  # network, quota, bad JSON, timeout...
                p.breaker.fail()
                errors.append(f"{p.name}: {describe(exc)}")
        paused = [p.name for p in capable if p.configured and not p.available()]
        if not errors and paused:
            raise ProviderError("providers paused after repeated errors: " + ", ".join(paused) + " (retry in about 30 s)")
        raise ProviderError(", ".join(errors) or "no AI provider configured")

    def status(self):
        return [{"name": p.name, "configured": p.configured, "available": p.available()} for p in self.providers]