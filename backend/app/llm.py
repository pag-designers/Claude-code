"""One place for every Claude call: strict JSON (validated by Pydantic), caching, refusal fallback, cost logging."""
import json
import time
from pathlib import Path
from typing import Callable, TypeVar

from pydantic import BaseModel

from .config import DATA, PRICES, PROMPTS, api_key, claude_effort, claude_model, has_api_key, video_dir

T = TypeVar("T", bound=BaseModel)

# Tests can set this to a function(system, user, schema) -> schema instance to avoid real API calls.
fake_call: Callable[[str, str, type], BaseModel] | None = None

_client = None
_client_key = None
_FALLBACK_MODELS = {"claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-opus-5"}


class LLMError(RuntimeError):
    pass


def prompt(name: str) -> str:
    return (PROMPTS / name).read_text(encoding="utf-8")


def _get_client():
    global _client, _client_key
    if not has_api_key():
        raise LLMError("No API key yet. Open Settings (⚙ top right) and paste your Anthropic API key.")
    if _client is None or _client_key != api_key():  # key changed in Settings → new client
        import anthropic
        _client = anthropic.Anthropic(api_key=api_key(), max_retries=4, timeout=600)
        _client_key = api_key()
    return _client


def cost_usd(model: str, usage) -> float:
    pin, pout = PRICES.get(model, PRICES["claude-haiku-5-5"])
    cache_w = getattr(usage, "cache_creation_input_tokens", 0) or 0
    cache_r = getattr(usage, "cache_read_input_tokens", 0) or 0
    return (usage.input_tokens * pin + cache_w * pin * 1.25 + cache_r * pin * 0.1
            + usage.output_tokens * pout) / 1e6


def _log(video_id: str | None, tag: str, model: str, usage, seconds: float) -> None:
    rec = {"t": round(time.time()), "tag": tag, "model": model, "in": usage.input_tokens,
           "cache_w": getattr(usage, "cache_creation_input_tokens", 0) or 0,
           "cache_r": getattr(usage, "cache_read_input_tokens", 0) or 0,
           "out": usage.output_tokens, "usd": round(cost_usd(model, usage), 5), "sec": round(seconds, 1)}
    paths = [DATA / "usage.jsonl"] + ([video_dir(video_id) / "usage.jsonl"] if video_id else [])
    for p in paths:
        with open(p, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")


def video_cost(video_id: str) -> dict:
    p: Path = video_dir(video_id) / "usage.jsonl"
    if not p.exists():
        return {"usd": 0.0, "calls": 0}
    recs = [json.loads(line) for line in p.read_text().splitlines() if line.strip()]
    by_tag: dict[str, float] = {}
    for r in recs:
        by_tag[r["tag"]] = round(by_tag.get(r["tag"], 0) + r["usd"], 4)
    return {"usd": round(sum(r["usd"] for r in recs), 4), "calls": len(recs), "by_step": by_tag,
            "tokens_in": sum(r["in"] + r["cache_w"] + r["cache_r"] for r in recs),
            "tokens_out": sum(r["out"] for r in recs)}


def call_json(schema: type[T], system: str, user: str, *, context: str | None = None,
              video_id: str | None = None, tag: str = "call", effort: str | None = None,
              max_tokens: int = 32000) -> T:
    """Ask Claude for JSON matching `schema`.

    `context` (e.g. a full transcript) is sent as a cached system block, so repeated calls over the same
    video (scoring, find-moments, variants) pay ~10% for it after the first call.
    """
    if fake_call is not None:
        return fake_call(system, (context or "") + "\n" + user, schema)  # type: ignore[return-value]
    client = _get_client()
    system_blocks = [{"type": "text", "text": system}]
    if context:
        system_blocks.append({"type": "text", "text": context, "cache_control": {"type": "ephemeral"}})
    model = claude_model()
    kwargs = {}
    if model in _FALLBACK_MODELS:
        # If a safety classifier declines (rare false positives on e.g. medical/crime podcasts),
        # the API retries on a fallback model inside the same call.
        kwargs = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
    t0 = time.time()
    import anthropic
    from pydantic import ValidationError
    # The JSON schema goes in output_config (not output_format): output_format makes the SDK parse every text
    # block mid-stream, so a cut-off or refused answer would crash before we can check why it stopped.
    fmt = {"type": "json_schema", "schema": anthropic.transform_schema(schema.model_json_schema())}
    try:
        with client.beta.messages.stream(
            model=model, max_tokens=max_tokens, system=system_blocks,
            messages=[{"role": "user", "content": user}],
            output_config={"effort": effort or claude_effort(), "format": fmt}, **kwargs,
        ) as stream:
            resp = stream.get_final_message()
    except anthropic.APIError as e:
        raise LLMError(friendly_api_error(e)) from e
    # Cost log: a fallback model is priced at its own rate when known, else at the selected model's rate.
    _log(video_id, tag, resp.model if resp.model in PRICES else model, resp.usage, time.time() - t0)
    if resp.stop_reason == "refusal":
        raise LLMError("Claude declined this request (safety classifier).")
    if resp.stop_reason == "max_tokens":
        raise LLMError(f"Claude ran out of output tokens ({max_tokens}) on step '{tag}'.")
    texts = [b for b in resp.content if b.type == "text"]
    if not texts:
        raise LLMError(f"Claude returned no JSON on step '{tag}'.")
    try:  # after a fallback, the final text block is the served answer
        return schema.model_validate_json(texts[-1].text)
    except ValidationError as e:
        raise LLMError(f"Claude's answer on step '{tag}' wasn't valid; press the button again to retry.") from e


def friendly_api_error(e) -> str:
    """Turn API errors into a next step a beginner can act on."""
    import anthropic
    msg = str(getattr(e, "message", e))
    if "credit balance" in msg.lower():
        return ("Your Anthropic account has no credit. Add $5 at console.anthropic.com → Settings → Billing, "
                "then press “Find clips again”.")
    if isinstance(e, anthropic.AuthenticationError):
        return "Anthropic rejected the API key. Open Settings (⚙, top right) and paste your key again."
    if isinstance(e, anthropic.PermissionDeniedError):
        return "This API key isn't allowed to use that model. Pick another model in Settings (⚙)."
    if isinstance(e, anthropic.RateLimitError):
        return "Anthropic's rate limit was hit. Wait a minute and try again."
    if isinstance(e, anthropic.APIConnectionError):
        return "Couldn't reach Anthropic. Check your internet connection and try again."
    if isinstance(e, anthropic.APIStatusError) and e.status_code >= 500:
        return "Anthropic's servers had a hiccup. Wait a minute and try again."
    return f"Claude API error: {msg}"
