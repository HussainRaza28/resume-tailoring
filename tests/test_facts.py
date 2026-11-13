"""Tests for the facts bank: answers are saved once and reused."""

import pytest

from app.core.facts import FactsBank, FactsError


def test_add_skip_dedupe_and_ids():
    bank = FactsBank()
    assert bank.add("   ", "How many users?") is None
    assert bank.add("TrailMap has 140 users", "How many users?", "Built a web app") == "f1"
    assert bank.add("trailmap  has 140 users") == "f1"
    assert bank.add("Budget Bot runs weekly") == "f2"
    assert bank.remove("f1")
    assert not bank.remove("f1")
    assert bank.add("New fact") == "f3", "ids are never reused"
    assert bank.update("f2", "Budget Bot posts weekly")
    assert not bank.update("f2", " ")
    assert not bank.update("f99", "x")
    assert bank.get("f2").text == "Budget Bot posts weekly"


def test_reuses_answers_for_the_same_bullet():
    bank = FactsBank()
    bank.add("The app had 40 beta users", "How many users?", "Built a  native macOS app")
    assert bank.answer_for("built a native macOS app", "how many users?") is not None
    assert bank.answer_for("Built something else", "How many users?") is None
    assert bank.answer_for("Built a native macOS app", "How many downloads?") is None
    assert len(bank.for_bullet("Built a native macOS app")) == 1


def test_save_and_load(tmp_path):
    path = tmp_path / "private" / "facts.json"
    assert FactsBank.load(path) == FactsBank()
    bank = FactsBank()
    bank.add("Fact one")
    bank.save(path)
    assert FactsBank.load(path) == bank
    assert not path.with_suffix(".json.tmp").exists()
    path.write_text("   ")
    assert FactsBank.load(path) == FactsBank()
    path.write_text("{not json")
    with pytest.raises(FactsError):
        FactsBank.load(path)
