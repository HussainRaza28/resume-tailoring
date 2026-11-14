"""A small reply shape for the provider tests.

The provider tests only need some strict schema with a nested list. This one
has the company, role and red flags fields, as the Diagnose reply does.
"""

from app.core.schemas import RedFlag, Strict


class SampleReply(Strict):
    company: str
    role: str
    red_flags: list[RedFlag]
