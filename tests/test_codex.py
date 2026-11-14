"""Tests for the ChatGPT (Codex) provider, run against a fake `codex` command.

The fake records its arguments, environment, working folder, standard input and
the schema file it was given. It prints `codex exec --json` event lines and
writes the final answer to the `-o` file, as codex-cli 0.169.0 does. The event
shapes for a failed turn were copied from the real CLI.
"""

import json
import sys
from pathlib import Path

import pytest

from app.providers.base import BadOutput, CompletionRequest, OtherError
from app.providers.codex import CodexMissing, CodexProvider, NotSignedIn, child_env, prompt_text, status
from tests.sample_schema import SampleReply

REPLY = {"company": "Larkspur Freight", "role": "Platform Intern", "red_flags": []}

FAKE_CODEX = r'''
import json, os, sys
mode = os.environ.get("FAKE_MODE", "ok")
args = sys.argv[1:]
if args == ["--version"]:
    print("codex-cli 0.169.0"); sys.exit(0)
if args[:2] == ["login", "status"]:
    if mode == "logged_out":
        print("Not logged in"); sys.exit(1)
    if mode == "api_key":
        print("API key configured - sk-test-***-real"); sys.exit(0)
    sys.stderr.write("Logged in using ChatGPT\n"); sys.exit(0)
assert args[0] == "exec" and args[-1] == "-"
stdin = sys.stdin.read()
schema_path = args[args.index("--output-schema") + 1]
out_path = args[args.index("-o") + 1]
with open(os.environ["FAKE_RECORD"], "w") as f:
    json.dump({"argv": args, "cwd": os.getcwd(), "stdin": stdin, "schema": json.load(open(schema_path)),
               "env_keys": sorted(k for k in os.environ if k in ("OPENAI_API_KEY", "CODEX_API_KEY"))}, f)
def out(obj): print(json.dumps(obj), flush=True)
out({"type": "thread.started", "thread_id": "t1"})
out({"type": "turn.started"})
out({"type": "error", "message": "Reconnecting... 1/5 (stream disconnected)"})
if mode == "logged_out":
    out({"type": "turn.failed", "error": {"message": "unexpected status 401 Unauthorized: Not logged in"}}); sys.exit(1)
if mode == "fail":
    out({"type": "turn.failed", "error": {"message": "workspace routing discovery failed"}}); sys.exit(1)
reply = os.environ["FAKE_REPLY"]
out({"type": "item.completed", "item": {"id": "item_1", "type": "reasoning", "text": "thinking"}})
out({"type": "item.completed", "item": {"id": "item_2", "type": "agent_message", "text": reply}})
out({"type": "turn.completed", "usage": {"input_tokens": 1200, "cached_input_tokens": 900, "output_tokens": 40}})
with open(out_path, "w") as f:
    f.write(reply)
'''


@pytest.fixture
def fake(tmp_path, monkeypatch):
    script = tmp_path / "fake_codex.py"
    script.write_text(FAKE_CODEX)
    if sys.platform == "win32":
        launcher = tmp_path / "codex.cmd"
        launcher.write_text(f'@"{sys.executable}" "{script}" %*\r\n')
    else:
        launcher = tmp_path / "codex"
        launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n')
        launcher.chmod(0o755)
    record = tmp_path / "record.json"
    monkeypatch.setenv("FAKE_RECORD", str(record))
    monkeypatch.setenv("FAKE_REPLY", json.dumps(REPLY))
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-not-be-used")
    monkeypatch.setenv("CODEX_API_KEY", "should-not-be-used")

    class Fake:
        command = str(launcher)

        @staticmethod
        def recorded():
            return json.loads(record.read_text())

    return Fake


def request():
    return CompletionRequest(step="score", system="Rules.", context="The resume.", user="The posting.", schema=SampleReply)


def test_answer_comes_from_the_output_file_and_streams(fake):
    seen = []
    out = CodexProvider(command=fake.command).complete(request(), seen.append)
    assert out.data == SampleReply(**REPLY)
    assert seen == [json.dumps(REPLY)], "only the agent's message is shown, not its reasoning"
    assert (out.usage.input_tokens, out.usage.cache_read_tokens, out.usage.output_tokens) == (300, 900, 40)


def test_flags_prompt_schema_and_environment(fake):
    CodexProvider(command=fake.command, model="gpt-5.5").complete(request())
    rec = fake.recorded()
    argv = rec["argv"]
    assert argv[0] == "exec" and argv[-1] == "-"
    for flag in ("--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config"):
        assert flag in argv, flag
    assert argv[argv.index("-s") + 1] == "read-only"
    assert argv[argv.index("-m") + 1] == "gpt-5.5"
    # Compared resolved: on macOS the temp folder is under /var, which is a link to /private/var.
    assert Path(argv[argv.index("-C") + 1]).resolve() == Path(rec["cwd"]).resolve(), "runs in its own empty folder"
    # The step's schema goes in a file, and the whole prompt on standard input.
    assert rec["schema"]["additionalProperties"] is False
    assert set(rec["schema"]["required"]) == {"company", "role", "red_flags"}
    assert rec["stdin"] == prompt_text(request())
    assert rec["stdin"].startswith("Rules.\n\nThe resume.\n\nThe posting.")
    # The ChatGPT sign-in is used, never an API key from the environment.
    assert rec["env_keys"] == []


def test_default_model_leaves_the_choice_to_codex(fake):
    CodexProvider(command=fake.command).complete(request())
    assert "-m" not in fake.recorded()["argv"]


def test_retry_messages_are_not_failures_but_a_failed_turn_is(fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "fail")
    with pytest.raises(OtherError, match="workspace routing discovery failed"):
        CodexProvider(command=fake.command).complete(request())


def test_not_signed_in_is_reported_as_such(fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "logged_out")
    with pytest.raises(NotSignedIn):
        CodexProvider(command=fake.command).complete(request())


def test_an_answer_that_does_not_fit_the_schema_is_refused(fake, monkeypatch):
    monkeypatch.setenv("FAKE_REPLY", '{"company": "A"}')
    with pytest.raises(BadOutput):
        CodexProvider(command=fake.command).complete(request())


def test_missing_codex(monkeypatch, tmp_path):
    monkeypatch.setattr("app.providers.codex.find_codex", lambda configured=None: None)
    with pytest.raises(CodexMissing):
        CodexProvider().complete(request())


def test_status_reads_version_and_sign_in(fake, monkeypatch):
    info = status(fake.command)
    assert info == {"installed": True, "signed_in": True, "path": fake.command, "version": "0.169.0",
                    "auth_method": "chatgpt"}
    monkeypatch.setenv("FAKE_MODE", "api_key")
    info = status(fake.command)
    assert info["auth_method"] == "api_key" and info["signed_in"] is False, "an API key isn't the ChatGPT plan"
    monkeypatch.setenv("FAKE_MODE", "logged_out")
    assert status(fake.command)["signed_in"] is False


def test_status_when_codex_is_not_installed(monkeypatch):
    monkeypatch.setattr("app.providers.codex.find_codex", lambda configured=None: None)
    assert status() == {"installed": False, "signed_in": False, "path": None, "version": None, "auth_method": None}


def test_child_env_drops_api_keys(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "x")
    monkeypatch.setenv("CODEX_API_KEY", "y")
    env = child_env()
    assert "OPENAI_API_KEY" not in env and "CODEX_API_KEY" not in env and "PATH" in env


def test_the_bridge_builds_codex_and_reports_its_status(tmp_path, monkeypatch):
    from app.bridge import Backend, Bridge
    from app.core.db import Db
    from app.core.secrets import MemoryStore

    monkeypatch.setattr("app.providers.codex.find_codex", lambda configured=None: None)
    db = Db(":memory:")
    backend = Backend(tmp_path, db, MemoryStore())
    assert Bridge(backend).call("codex_status", {})["ok"]["installed"] is False
    provider = backend._provider("codex", "default")
    assert isinstance(provider, CodexProvider) and provider.chosen_model == ""
    assert backend._provider("codex", "gpt-5.5").chosen_model == "gpt-5.5"
    db.close()
