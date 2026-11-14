"""Is a listing's location in the United States?

Rules, not a list of cities: a US state's name or two-letter code (and DC and
Puerto Rico), the country written as "US", "USA", "U.S." or "United States",
or remote work marked as US. A short list of aliases covers the cities that listings name
without a state, such as "NYC" or "SF". Anything that names Canada or one of
its provinces is not US, since "CA" also stands for California.
"""

from __future__ import annotations

import re

STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado",
    "CT": "Connecticut", "DE": "Delaware", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
    "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi",
    "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey",
    "NM": "New Mexico", "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
    "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota",
    "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
    "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming", "DC": "District of Columbia", "PR": "Puerto Rico",
}

# Cities that listings write without a state. Kept short on purpose: anything
# with a state code is already caught by the rules above.
CITY_ALIASES = [
    "nyc", "new york city", "sf", "san francisco", "bay area", "sf bay area", "silicon valley", "seattle",
    "boston", "chicago", "austin", "los angeles", "washington dc", "washington d.c.", "d.c.", "dc",
]

CANADA = ["canada", "ontario", "british columbia", "quebec", "alberta", "manitoba", "nova scotia"]
CANADA_CODES = {"ON", "BC", "QC", "AB", "MB", "NS", "NB", "NL", "PE", "SK", "YT", "NT", "NU"}

_STATE_CODE = re.compile(r"(?:^|[,(/\s])\s*(" + "|".join(STATES) + r")\s*(?:$|[,)/\s])")
_STATE_NAME = re.compile(r"\b(" + "|".join(re.escape(n.lower()) for n in STATES.values()) + r")\b")
_COUNTRY = re.compile(r"\b(united states(?: of america)?|usa|u\.s\.a?\.?|us)\b")
_ALIAS = re.compile(r"(?:^|[\s,(/])(" + "|".join(re.escape(a) for a in CITY_ALIASES) + r")(?:$|[\s,)/])")
_CANADA_CODE = re.compile(r",\s*(" + "|".join(CANADA_CODES) + r")\b")


def is_us(location: str) -> bool:
    """True when ``location`` is somewhere in the United States, or remote work in the US."""
    text = " ".join(location.split())
    lower = text.lower()
    if any(name in lower for name in CANADA) or _CANADA_CODE.search(text):
        return False
    if _COUNTRY.search(lower):
        return True
    # A two-letter state code is trusted in capitals anywhere ("Austin, TX"), so "in" or "me" in prose
    # doesn't count. In other cases it must be the last part on its own ("Carlsbad, Ca").
    if _STATE_CODE.search(text):
        return True
    last = text.rsplit(",", 1)[-1].strip() if "," in text else ""
    if last.upper() in STATES and len(last) == 2:
        return True
    return bool(_STATE_NAME.search(lower) or _ALIAS.search(lower))


# Typed into the location filter, these mean "anywhere in the US".
US_QUERIES = {"us", "usa", "u.s.", "u.s.a.", "united states", "united states of america", "america"}


def means_us(query: str) -> bool:
    return " ".join(query.lower().split()) in US_QUERIES
