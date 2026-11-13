from app.core.pricing import cost, price_for
from app.providers.base import Usage


def test_sonnet_cost_counts_cache_separately():
    u = Usage(input_tokens=1_000_000, output_tokens=100_000, cache_read_tokens=1_000_000)
    assert abs(cost("claude_api", "claude-sonnet-5-5", u) - (2.0 + 1.0 + 0.10)) < 1e-9


def test_longest_prefix_wins_and_unknown_is_none():
    assert price_for("claude_api", "claude-sonnet-5").cache_read == 0.20
    assert price_for("claude_api", "claude-sonnet-5-5").cache_read == 0.10
    assert price_for("claude_api", "claude-unknown") is None
    assert cost("claude_api", "claude-unknown", Usage(input_tokens=5)) is None


def test_plan_free_and_local_providers_cost_nothing():
    u = Usage(input_tokens=5000, output_tokens=900)
    for provider in ("claude_code", "gemini", "ollama", "demo"):
        assert cost(provider, "any-model", u) == 0.0
