"""Google Gemini through the ``google-genai`` SDK.

Structured output uses ``response_json_schema`` with a JSON reply type. The
fixed instructions and the resume go first, in the system instruction, so
Gemini's automatic caching can reuse them from one step to the next.
"""

from __future__ import annotations

import httpx2
from google import genai
from google.genai import errors, types

from app.providers.base import (
    BadKey,
    BadOutput,
    CompletionRequest,
    DeltaSink,
    MissingKey,
    Offline,
    OtherError,
    Provider,
    ProviderError,
    RateLimited,
    RawReply,
    ServerError,
    Usage,
)

# An alias that follows Google's current Flash model, which the free tier covers.
DEFAULT_MODEL = "gemini-flash-latest"

# Finish reasons that mean Gemini stopped before giving a full answer.
_BLOCKED = {"SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "RECITATION", "SPII"}


class GeminiProvider(Provider):
    kind = "gemini"
    label = "Gemini"

    def __init__(self, api_key: str, model: str = DEFAULT_MODEL, base_url: str | None = None) -> None:
        super().__init__(model)
        if not api_key:
            raise MissingKey()
        options = types.HttpOptions(base_url=base_url) if base_url else None
        self.client = genai.Client(api_key=api_key, http_options=options)

    def _config(self, request: CompletionRequest) -> types.GenerateContentConfig:
        return types.GenerateContentConfig(
            system_instruction=f"{request.system}\n\n{request.context}",
            response_mime_type="application/json",
            response_json_schema=request.json_schema(),
            # Thinking tokens count against this limit too, so leave room for them.
            max_output_tokens=max(request.max_tokens, 2048) * 2,
        )

    def _send(self, request: CompletionRequest, on_delta: DeltaSink) -> RawReply:
        try:
            chunks = self.client.models.generate_content_stream(
                model=self.model, contents=request.user, config=self._config(request)
            )
            text, usage, model, finish = self._read(chunks, on_delta)
        except errors.APIError as e:
            raise map_error(e) from e
        except httpx2.TransportError as e:
            raise Offline() from e

        if finish in _BLOCKED:
            raise BadOutput(f"Gemini stopped the reply ({finish})")
        if finish == "MAX_TOKENS":
            raise BadOutput("the reply was cut off at the token limit")
        return RawReply(text=text, usage=usage, model=model)

    def _read(self, chunks, on_delta: DeltaSink) -> tuple[str, Usage, str, str]:
        text = []
        usage = Usage()
        model = self.model
        finish = ""
        for chunk in chunks:
            if chunk.model_version:
                model = chunk.model_version
            candidate = chunk.candidates[0] if chunk.candidates else None
            if candidate and candidate.content and candidate.content.parts:
                for part in candidate.content.parts:
                    if part.text and not part.thought:  # skip the model's thinking
                        text.append(part.text)
                        on_delta(part.text)
            if candidate and candidate.finish_reason:
                finish = str(getattr(candidate.finish_reason, "value", candidate.finish_reason))
            meta = chunk.usage_metadata
            if meta:
                cached = meta.cached_content_token_count or 0
                usage = Usage(
                    input_tokens=(meta.prompt_token_count or 0) - cached,
                    cache_read_tokens=cached,
                    output_tokens=(meta.candidates_token_count or 0) + (meta.thoughts_token_count or 0),
                )
        return "".join(text), usage, model, finish

    def list_models(self) -> list[str]:
        """Gemini models this key can use to generate text, for the model picker in Settings."""
        try:
            return [
                m.name.removeprefix("models/")
                for m in self.client.models.list()
                if m.name and "gemini" in m.name and "generateContent" in (m.supported_actions or [])
            ]
        except errors.APIError as e:
            raise map_error(e) from e
        except httpx2.TransportError as e:
            raise Offline() from e


def map_error(e: errors.APIError) -> ProviderError:
    """Turn an SDK error into one of the app's provider errors."""
    message = e.message or str(e)
    # Gemini reports a bad key as 400 with "API key not valid" or API_KEY_INVALID.
    bad_key_400 = e.code == 400 and ("api key not valid" in message.lower() or "API_KEY_INVALID" in str(e))
    if e.code in (401, 403) or bad_key_400:
        return BadKey(message)
    if e.code == 429:
        return RateLimited()
    if e.code >= 500:
        return ServerError(message)
    return OtherError(f"Request failed: {message}")
