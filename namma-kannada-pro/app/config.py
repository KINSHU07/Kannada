"""Typed settings, read once from environment variables."""
import os
from dataclasses import dataclass
from pathlib import Path


def load_dotenv(path=None):
    """Load KEY=value lines from a .env file next to the project (never overrides real env vars)."""
    path = Path(path) if path else Path(__file__).resolve().parent.parent / ".env"
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and value:
            os.environ.setdefault(key, value)


def _int(name, default):
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    hf_token: str = ""
    gemini_key: str = ""
    providers: tuple = ("gemini", "hf")          # fallback order
    gemini_model: str = "gemini-flash-latest"   # auto-switches if retired
    hf_mt_model: str = "facebook/nllb-200-distilled-600M"
    hf_chat_model: str = ""                        # empty = auto-discover a served model
    hf_vision_model: str = "Qwen/Qwen2.5-VL-7B-Instruct"
    ai_timeout: int = 35
    rate_ai_per_min: int = 20
    rate_tts_per_min: int = 120
    trust_proxy: bool = False                      # honour X-Forwarded-For (set on Render/Fly/etc.)
    cache_size: int = 1000
    cache_ttl: int = 6 * 3600
    max_image_bytes: int = 5 * 1024 * 1024

    @classmethod
    def from_env(cls):
        load_dotenv()
        providers = tuple(p.strip().lower() for p in os.getenv("AI_PROVIDERS", "gemini,hf").split(",") if p.strip())
        return cls(
            hf_token=os.getenv("HF_TOKEN", ""),
            gemini_key=os.getenv("GEMINI_API_KEY", ""),
            providers=providers,
            gemini_model=os.getenv("GEMINI_MODEL", cls.gemini_model),
            hf_mt_model=os.getenv("HF_MT_MODEL", cls.hf_mt_model),
            hf_chat_model=os.getenv("HF_CHAT_MODEL", ""),
            hf_vision_model=os.getenv("HF_VISION_MODEL", cls.hf_vision_model),
            ai_timeout=_int("AI_TIMEOUT", cls.ai_timeout),
            rate_ai_per_min=_int("RATE_AI_PER_MIN", cls.rate_ai_per_min),
            rate_tts_per_min=_int("RATE_TTS_PER_MIN", cls.rate_tts_per_min),
            trust_proxy=os.getenv("TRUST_PROXY", "").lower() in ("1", "true", "yes"),
        )