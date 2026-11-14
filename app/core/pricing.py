"""Prices for the cost footer, in US dollars per million tokens.

Only the Claude API is billed per token. Claude Code runs on the user's Claude
plan, Gemini's free tier and the local and demo providers cost nothing, and a
model that isn't in the table returns None, which the interface shows as a dash.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.providers.base import Usage


@dataclass(frozen=True)
class Price:
    input: float
    output: float
    # Writing to the prompt cache costs 1.25 times the input price.
    cache_write: float
    cache_read: float


# Matched by model id prefix; the longest match wins.
CLAUDE_PRICES = {
    "claude-sonnet-5-5": Price(input=2.00, output=10.00, cache_write=2.50, cache_read=0.10),
    "claude-sonnet-5": Price(input=2.00, output=10.00, cache_write=2.50, cache_read=0.20),
    "claude-opus-5-5": Price(input=4.00, output=20.00, cache_write=5.00, cache_read=0.20),
    "claude-fable-5-2": Price(input=8.00, output=40.00, cache_write=10.00, cache_read=0.20),
}

FREE = Price(0.0, 0.0, 0.0, 0.0)
# Providers that never charge per token.
FREE_PROVIDERS = {"claude_code", "codex", "gemini", "ollama", "demo", "fake"}


def price_for(provider: str, model: str) -> Price | None:
    if provider in FREE_PROVIDERS:
        return FREE
    matches = [prefix for prefix in CLAUDE_PRICES if model.startswith(prefix)]
    return CLAUDE_PRICES[max(matches, key=len)] if matches else None


def cost(provider: str, model: str, usage: Usage) -> float | None:
    """Cost in dollars. ``usage.input_tokens`` is the uncached input, as the APIs report it."""
    price = price_for(provider, model)
    if price is None:
        return None
    return (
        usage.input_tokens * price.input
        + usage.output_tokens * price.output
        + usage.cache_write_tokens * price.cache_write
        + usage.cache_read_tokens * price.cache_read
    ) / 1_000_000
