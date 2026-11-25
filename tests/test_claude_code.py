"""Tests for the Claude Code provider, run against a fake `claude` command.

The fake records its arguments, environment, working folder and standard input,
and prints the stream-json lines that `claude -p` prints.
"""

import json
import sys

import pytest

from tests.sample_schema import SampleReply
from app.providers.base import BadOutput, CompletionRequest, OtherError
from app.providers.claude_code import (
    ClaudeCodeMissing,
    ClaudeCodeProvider,
    NotSignedIn,
    child_env,
    status,
)

REPLY = {"company": "Larkspur Freight", "role": "Platform Intern", "red_flags": []}

FAKE_CLAUDE = r'''
import json, os, sys
record = os.environ["FAKE_RECORD"]
mode = os.environ.get("FAKE_MODE", "structured")
if sys.argv[1:] == ["--version"]:
    print("2.1.325 (Claude Code)"); sys.exit(0)
if sys.argv[1:4] == ["auth", "status", "--json"]:
    print(json.dumps({"loggedIn": mode != "logged_out", "authMethod": "claude.ai"})); sys.exit(0)
stdin = sys.stdin.read()
with open(record, "w") as f:
    json.dump({"argv": sys.argv[1:], "cwd": os.getcwd(), "stdin": stdin,
               "env_keys": [k for k in os.environ if k.startswith("ANTHROPIC_")]}, f)
reply = os.environ["FAKE_REPLY"]
def out(obj): print(json.dumps(obj), flush=True)
out({"type": "system", "subtype": "init", "model": "claude-sonnet-5-5"})
print("a plain warning line", flush=True)
if mode == "crash":
    sys.stderr.write("fatal: something broke\n"); sys.exit(1)
if mode == "silent":
    import time; time.sleep(60); sys.exit(0)
half = len(reply) // 2
delta_type = "input_json_delta" if mode == "structured" else "text_delta"
key = "partial_json" if mode == "structured" else "text"
for piece in (reply[:half], reply[half:]):
    out({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
         "delta": {"type": delta_type, key: piece}}})
usage = {"input_tokens": 12, "output_tokens": 40, "cache_read_input_tokens": 900, "cache_creation_input_tokens": 50}
if mode == "logged_out":
    out({"type": "result", "subtype": "success", "is_error": True,
         "result": "Not logged in · Please run /login"}); sys.exit(1)
if mode == "schema_failed":
    out({"type": "result", "subtype": "error_max_structured_output_retries", "is_error": True}); sys.exit(1)
result = {"type": "result", "subtype": "success", "is_error": False, "usage": usage,
          "total_cost_usd": 0.01, "modelUsage": {"claude-sonnet-5-5": {}}}
if mode == "structured":
    result["structured_output"] = json.loads(reply); result["result"] = ""
else:
    result["result"] = reply
out(result)
if mode == "linger":
    # Answered, but the output stays open, as when a helper process outlives the answer.
    import time; time.sleep(60)
'''


# cmd.exe can't pass an argument that contains newlines, and the system prompt
# has them, so a .cmd stand-in can't play `claude` on Windows.
windows_launcher = pytest.mark.skipif(sys.platform == "win32", reason="cmd.exe launchers can't pass newlines")


@pytest.fixture
def fake(tmp_path, monkeypatch):
    script = tmp_path / "fake_claude.py"
    script.write_text(FAKE_CLAUDE)
    launcher = tmp_path / "claude"
    launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n')
    launcher.chmod(0o755)
    record = tmp_path / "record.json"
    monkeypatch.setenv("FAKE_RECORD", str(record))
    monkeypatch.setenv("FAKE_REPLY", json.dumps(REPLY))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-should-not-be-used")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "should-not-be-used")

    class Fake:
        command = str(launcher)

        @staticmethod
        def recorded():
            return json.loads(record.read_text())

    return Fake


def request():
    return CompletionRequest(step="diagnose", system="Rules.", context="The resume.", user="The posting.",
                             schema=SampleReply)


@windows_launcher
def test_structured_output_streams_and_is_checked(fake):
    seen = []
    out = ClaudeCodeProvider(command=fake.command).complete(request(), seen.append)
    assert out.data == SampleReply(**REPLY)
    assert "".join(seen) == json.dumps(REPLY)
    assert out.usage.cache_read_tokens == 900 and out.usage.output_tokens == 40
    assert out.model == "claude-sonnet-5-5"


@windows_launcher
def test_text_result_is_used_when_there_is_no_structured_output(fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "text")
    assert ClaudeCodeProvider(command=fake.command).complete(request()).data.company == "Larkspur Freight"


@windows_launcher
def test_flags_prompt_and_environment(fake):
    ClaudeCodeProvider(command=fake.command, model="opus", effort="low").complete(request())
    rec = fake.recorded()
    argv = rec["argv"]
    assert argv[0] == "-p"
    assert argv[argv.index("--output-format") + 1] == "stream-json"
    assert "--verbose" in argv and "--include-partial-messages" in argv and "--no-session-persistence" in argv
    assert argv[argv.index("--model") + 1] == "opus"
    assert argv[argv.index("--effort") + 1] == "low"
    assert argv[argv.index("--tools") + 1] == ""
    assert argv[argv.index("--system-prompt") + 1] == "Rules.\n\nThe resume."
    schema = json.loads(argv[argv.index("--json-schema") + 1])
    assert schema["additionalProperties"] is False
    assert rec["stdin"].startswith("The posting.")
    # The plan login is used, never an API key.
    assert "ANTHROPIC_API_KEY" not in rec["env_keys"]
    assert "ANTHROPIC_AUTH_TOKEN" not in rec["env_keys"]


def test_child_env_drops_api_variables(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "y")
    monkeypatch.setenv("TAILOR_KEEP", "z")
    env = child_env()
    assert "ANTHROPIC_API_KEY" not in env and "ANTHROPIC_AUTH_TOKEN" not in env
    assert env["TAILOR_KEEP"] == "z"


@windows_launcher
def test_runs_in_an_empty_folder(fake, tmp_path):
    ClaudeCodeProvider(command=fake.command).complete(request())
    assert fake.recorded()["cwd"] != str(tmp_path)


@windows_launcher
def test_not_signed_in(fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "logged_out")
    with pytest.raises(NotSignedIn):
        ClaudeCodeProvider(command=fake.command).complete(request())


@windows_launcher
def test_crash_reports_stderr(fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "crash")
    with pytest.raises(OtherError, match="something broke"):
        ClaudeCodeProvider(command=fake.command).complete(request())


@windows_launcher
def test_schema_failure_is_an_error(fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "schema_failed")
    with pytest.raises(OtherError, match="structured_output"):
        ClaudeCodeProvider(command=fake.command).complete(request())


@windows_launcher
def test_wrong_shape_is_bad_output(fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "text")
    monkeypatch.setenv("FAKE_REPLY", '{"company": "A"}')
    with pytest.raises(BadOutput):
        ClaudeCodeProvider(command=fake.command).complete(request())


def test_missing_command(tmp_path, monkeypatch):
    monkeypatch.setattr("app.providers.claude_code.find_claude", lambda _c=None: None)
    with pytest.raises(ClaudeCodeMissing):
        ClaudeCodeProvider().complete(request())
    assert status()["installed"] is False


@windows_launcher
def test_status(fake, monkeypatch):
    info = status(fake.command)
    assert info == {"installed": True, "signed_in": True, "path": fake.command,
                    "version": "2.1.325", "auth_method": "claude.ai"}
    monkeypatch.setenv("FAKE_MODE", "logged_out")
    assert status(fake.command)["signed_in"] is False


@windows_launcher
def test_an_answer_is_used_even_when_the_command_lingers(fake, monkeypatch):
    import time

    from app.providers import claude_code

    monkeypatch.setenv("FAKE_MODE", "linger")
    monkeypatch.setattr(claude_code, "EXIT_GRACE_SECONDS", 0.5)
    started = time.monotonic()
    out = ClaudeCodeProvider(command=fake.command).complete(request())
    assert out.data == SampleReply(**REPLY)
    assert time.monotonic() - started < 15, "the step ends once the answer is in"


@windows_launcher
def test_a_command_that_stops_answering_is_stopped_with_an_error(fake, monkeypatch):
    import time

    from app.providers import claude_code

    monkeypatch.setenv("FAKE_MODE", "silent")
    monkeypatch.setattr(claude_code, "IDLE_SECONDS", 1)
    started = time.monotonic()
    with pytest.raises(OtherError, match="nothing came back for 1 seconds"):
        ClaudeCodeProvider(command=fake.command).complete(request())
    assert time.monotonic() - started < 15
