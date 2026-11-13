"""The facts bank: things you told the app that aren't in the base resume.

An example is the number of users a project had. Facts are saved as JSON in the
private data folder and reused across runs, and a rewrite can cite them as
sources. When the app asks "How many…?" about a bullet, the answer is stored
with the question and the bullet's text, so the same question isn't asked twice.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel, ValidationError


class FactsError(Exception):
    pass


class Fact(BaseModel):
    id: str
    # The fact as a sentence, such as "TrailMap has 140 users".
    text: str
    # The question that produced it, if it came from one.
    question: str | None = None
    # The original text of the bullet it's about, used to reuse answers.
    bullet_text: str | None = None
    created_at: str


def _normalize(s: str) -> str:
    return " ".join(s.lower().split())


class FactsBank(BaseModel):
    facts: list[Fact] = []

    @classmethod
    def load(cls, path: Path) -> FactsBank:
        """Read the bank. A missing or empty file is an empty bank."""
        try:
            raw = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return cls()
        except OSError as e:
            raise FactsError(f"could not read the facts bank: {e}") from e
        if not raw.strip():
            return cls()
        try:
            return cls.model_validate_json(raw)
        except ValidationError as e:
            raise FactsError(f"the facts bank file is not valid: {e}") from e

    def save(self, path: Path) -> None:
        """Write to a temporary file first, then swap it in.

        If the app quits halfway through, the old file is still whole.
        """
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(self.model_dump_json(indent=2), encoding="utf-8")
        os.replace(tmp, path)

    def _next_id(self) -> str:
        numbers = [int(f.id[1:]) for f in self.facts if f.id.startswith("f") and f.id[1:].isdigit()]
        return f"f{max(numbers, default=0) + 1}"

    def add(self, text: str, question: str | None = None, bullet_text: str | None = None) -> str | None:
        """Add a fact and return its id.

        Blank text means the user skipped the question, so nothing is saved and
        None comes back. A fact that's already in the bank (ignoring case and
        spacing) returns the existing id. Ids never get reused after a delete.
        """
        text = text.strip()
        if not text:
            return None
        for fact in self.facts:
            if _normalize(fact.text) == _normalize(text):
                return fact.id
        fact = Fact(
            id=self._next_id(),
            text=text,
            question=question,
            bullet_text=bullet_text,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        self.facts.append(fact)
        return fact.id

    def get(self, fact_id: str) -> Fact | None:
        return next((f for f in self.facts if f.id == fact_id), None)

    def remove(self, fact_id: str) -> bool:
        before = len(self.facts)
        self.facts = [f for f in self.facts if f.id != fact_id]
        return len(self.facts) != before

    def update(self, fact_id: str, text: str) -> bool:
        fact = self.get(fact_id)
        if fact is None or not text.strip():
            return False
        fact.text = text.strip()
        return True

    def for_bullet(self, bullet_text: str) -> list[Fact]:
        """Facts already given about this bullet."""
        key = _normalize(bullet_text)
        return [f for f in self.facts if f.bullet_text is not None and _normalize(f.bullet_text) == key]

    def answer_for(self, bullet_text: str, question: str) -> Fact | None:
        """An earlier answer to the same question about the same bullet."""
        q = _normalize(question)
        return next(
            (f for f in self.for_bullet(bullet_text) if f.question is not None and _normalize(f.question) == q), None
        )
