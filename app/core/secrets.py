"""API keys, kept in the operating system's keychain.

On macOS that's the Keychain, and on Windows the Credential Manager, through
the ``keyring`` package. Keys never go into files, logs or the interface: the
interface only ever gets a masked form such as ``sk-ant…a1b2``.
"""

from __future__ import annotations

from typing import Protocol

import keyring
from keyring.errors import KeyringError

SERVICE = "Tailor"

# The key names, by provider.
KEY_NAMES = {"claude_api": "anthropic_api_key", "gemini": "gemini_api_key"}


class SecretError(Exception):
    pass


class SecretStore(Protocol):
    def get(self, name: str) -> str | None: ...
    def set(self, name: str, value: str) -> None: ...
    def delete(self, name: str) -> None: ...


class KeychainStore:
    """The system keychain."""

    def get(self, name: str) -> str | None:
        try:
            return keyring.get_password(SERVICE, name)
        except KeyringError as e:
            raise SecretError(f"Could not read the keychain: {e}") from e

    def set(self, name: str, value: str) -> None:
        try:
            keyring.set_password(SERVICE, name, value)
        except KeyringError as e:
            raise SecretError(f"Could not save to the keychain: {e}") from e

    def delete(self, name: str) -> None:
        try:
            keyring.delete_password(SERVICE, name)
        except keyring.errors.PasswordDeleteError:
            pass  # already gone
        except KeyringError as e:
            raise SecretError(f"Could not remove the key from the keychain: {e}") from e


class MemoryStore:
    """Keys held in memory, for tests."""

    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    def get(self, name: str) -> str | None:
        return self.values.get(name)

    def set(self, name: str, value: str) -> None:
        self.values[name] = value

    def delete(self, name: str) -> None:
        self.values.pop(name, None)


def mask(key: str) -> str:
    """Show just enough of a key to recognize it: the first 6 and last 4 characters."""
    if len(key) <= 10:
        return "\u2022" * min(len(key), 8)
    return f"{key[:6]}\u2026{key[-4:]}"
