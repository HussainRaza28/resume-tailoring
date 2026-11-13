from pathlib import Path

from app.core.export import export_file_name, person_name
from app.core.secrets import MemoryStore, mask

SAMPLE = (Path(__file__).parent / "fixtures" / "sample_resume.tex").read_text(encoding="utf-8")


def test_memory_store_round_trip():
    s = MemoryStore()
    assert s.get("anthropic_api_key") is None
    s.set("anthropic_api_key", "sk-ant-123")
    assert s.get("anthropic_api_key") == "sk-ant-123"
    s.delete("anthropic_api_key")
    s.delete("anthropic_api_key")
    assert s.get("anthropic_api_key") is None


def test_mask_hides_the_middle():
    assert mask("sk-ant-api03-abcdefghijkl") == "sk-ant\u2026ijkl"
    assert "api03" not in mask("sk-ant-api03-abcdefghijkl")
    assert mask("short") == "\u2022" * 5


def test_person_name_from_the_header():
    assert person_name(SAMPLE) == "Jordan Sample"
    assert person_name("\\begin{document}\nno header\n\\end{document}") == ""


def test_export_names_are_safe():
    assert export_file_name("Jordan Sample", "Larkspur Freight") == "Jordan_Sample_Resume_Larkspur_Freight.pdf"
    assert export_file_name("Jordan Sample", "AT&T / Labs ") == "Jordan_Sample_Resume_AT_T_Labs.pdf"
    assert export_file_name("Jordan Sample", "../../etc") == "Jordan_Sample_Resume_etc.pdf"
    assert export_file_name("Jordan Sample", "  ") == "Jordan_Sample_Resume.pdf"
    assert export_file_name("", "Acme") == "Resume_Acme.pdf"
