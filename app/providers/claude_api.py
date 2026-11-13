"""Claude through the Anthropic API, using the official ``anthropic`` SDK.

- Structured output: ``output_config.format`` with the step's JSON schema, so
  the reply is JSON that fits the schema.
- Prompt caching: the instructions and the base resume go in as two system
  blocks, with a cache breakpoint on the second. Every step after the first in
  a run reads them from the cache, which is cheaper and faster.
- Refusal fallback: ``fallbacks: "default"`` lets the API rerun a request that
  the model's safety checks decline on a fallback model, inside the same call.
  If the account rejects the option, the call is sent again without it.
- Streaming: text is passed to the interface as it arrives.
"""

from __future__ import annotations

import anthropic

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

DEFAULT_MODEL = "claude-sonnet-5-5"
FALLBACK_BETA = "server-side-fallback-2026-07-01"
EFFORTS = ("low", "medium", "high")


class ClaudeApiProvider(Provider):
    kind = "claude_api"
    label = "Claude API"

    def __init__(
        self,
        api_key: str,
        model: str = DEFAULT_MODEL,
        effort: str | None = None,
        base_url: str | None = None,
    ) -> None:
        super().__init__(model)
        if not api_key:
            raise MissingKey()
        self.effort = effort
        # The SDK's own retries are off: Provider.complete retries every
        # provider the same way.
        self.client = anthropic.Anthropic(api_key=api_key, base_url=base_url, max_retries=0)
        self.use_fallbacks = True

    def _params(self, request: CompletionRequest) -> dict:
        output_config: dict = {"format": {"type": "json_schema", "schema": request.json_schema()}}
        if self.effort:
            output_config["effort"] = self.effort
        params = {
            "model": self.model,
            "max_tokens": max(request.max_tokens, 1024),
            "system": [
                {"type": "text", "text": request.system},
                {"type": "text", "text": request.context, "cache_control": {"type": "ephemeral"}},
            ],
            "messages": [{"role": "user", "content": request.user}],
            "output_config": output_config,
        }
        if self.use_fallbacks:
            params["betas"] = [FALLBACK_BETA]
            params["fallbacks"] = "default"
        return params

    def _send(self, request: CompletionRequest, on_delta: DeltaSink) -> RawReply:
        try:
            return self._stream(request, on_delta)
        except anthropic.BadRequestError as e:
            if self.use_fallbacks and "fallback" in str(e).lower():
                self.use_fallbacks = False
                return self._send(request, on_delta)
            raise OtherError(f"Request failed: {_message(e)}") from e
        except anthropic.APIError as e:
            raise map_error(e) from e

    def _stream(self, request: CompletionRequest, on_delta: DeltaSink) -> RawReply:
        with self.client.beta.messages.stream(**self._params(request)) as stream:
            for event in stream:
                if event.type == "text":
                    on_delta(event.text)
            message = stream.get_final_message()

        if message.stop_reason == "refusal":
            raise BadOutput("the model declined this request")
        if message.stop_reason == "max_tokens":
            raise BadOutput("the reply was cut off at the token limit")
        text = "".join(block.text for block in message.content if block.type == "text")
        u = message.usage
        usage = Usage(
            input_tokens=u.input_tokens or 0,
            output_tokens=u.output_tokens or 0,
            cache_read_tokens=u.cache_read_input_tokens or 0,
            cache_write_tokens=u.cache_creation_input_tokens or 0,
        )
        return RawReply(text=text, usage=usage, model=message.model)


def _message(e: anthropic.APIError) -> str:
    return getattr(e, "message", None) or str(e)


def map_error(e: anthropic.APIError) -> ProviderError:
    """Turn an SDK error into one of the app's provider errors."""
    if isinstance(e, (anthropic.AuthenticationError, anthropic.PermissionDeniedError)):
        return BadKey(_message(e))
    if isinstance(e, anthropic.RateLimitError):
        retry_after = e.response.headers.get("retry-after")
        try:
            return RateLimited(float(retry_after) if retry_after else None)
        except ValueError:
            return RateLimited()
    if isinstance(e, anthropic.APIStatusError) and e.status_code >= 500:
        return ServerError(_message(e))
    if isinstance(e, anthropic.APIConnectionError):
        return Offline()
    return OtherError(f"Request failed: {_message(e)}")
