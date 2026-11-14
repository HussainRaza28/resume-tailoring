"""Tests for telling US locations apart, with location strings copied from the three internship lists."""

import pytest

from app.importers.places import is_us, means_us

US = [
    # city and state code
    "Austin, TX",
    "San Francisco, CA",
    "New York, NY",
    "Indianapolis, IN",
    "Washington, D.C.",
    "Carlsbad, Ca",
    # state or country written out
    "California",
    "Washington",
    "Georgia",
    "Texas, USA",
    "Pennsylvania, USA +42",
    "California, USA +9",
    "Multiple Locations, United States",
    "United States",
    "US",
    "USA",
    # remote in the US
    "Remote (US)",
    "Remote in US",
    "Remote in USA",
    "Remote - USA",
    "Remote - Minnesota, USA",
    # cities written without a state
    "NYC",
    "SF",
    "South SF",
    "Chicago",
    # Puerto Rico
    "San Juan, Puerto Rico",
]

NOT_US = [
    "Toronto, ON",
    "Toronto, ON, Canada",
    "Vancouver, BC",
    "Ottawa, ON",
    "Montreal, QC",
    "Calgary, AB, Canada",
    "Waterloo, Canada",
    "Remote in Canada",
    "Remote - Canada",
    "London, UK",
    "Cambridge, UK",
    "Bengaluru, India",
    "Remote in India",
    "Berlin, Germany",
    "Remote in Germany",
    "Amsterdam, The Netherlands",
    "Singapore",
    "Mexico City, Mexico",
    "Tel Aviv, Israel",
    "Sydney, Australia",
    # can't be placed, so not counted as US
    "Remote",
    "Multiple Locations Available",
]


@pytest.mark.parametrize("location", US)
def test_us_locations(location):
    assert is_us(location), location


@pytest.mark.parametrize("location", NOT_US)
def test_locations_outside_the_us(location):
    assert not is_us(location), location


def test_a_state_code_needs_capitals_unless_it_ends_the_place():
    assert not is_us("Pop-up in the park")
    assert not is_us("Work from me")
    assert is_us("Austin, Tx")


def test_what_counts_as_asking_for_the_us():
    for query in ("United States", "united states", "US", "usa", "U.S.", "  USA "):
        assert means_us(query), query
    for query in ("Texas", "us east", "Austin"):
        assert not means_us(query), query
