"""Download Tectonic into packaging/bin/ for this computer, or for a named target.

Usage:
    uv run python scripts/fetch_tectonic.py
    uv run python scripts/fetch_tectonic.py aarch64-apple-darwin

The app finds it there in development, and PyInstaller bundles it from there.
The version is pinned so every build ships the same Tectonic.
"""

import io
import platform
import stat
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

VERSION = "0.15.0"
BASE = "https://github.com/tectonic-typesetting/tectonic/releases/download"

ARCHIVES = {
    "aarch64-apple-darwin": "tar.gz",
    "x86_64-apple-darwin": "tar.gz",
    "x86_64-pc-windows-msvc": "zip",
    "x86_64-unknown-linux-gnu": "tar.gz",
}

OUT_DIR = Path(__file__).resolve().parent.parent / "packaging" / "bin"


def this_target() -> str:
    system = platform.system()
    machine = platform.machine().lower()
    if system == "Darwin":
        return "aarch64-apple-darwin" if machine == "arm64" else "x86_64-apple-darwin"
    if system == "Windows":
        return "x86_64-pc-windows-msvc"
    if system == "Linux" and machine in ("x86_64", "amd64"):
        return "x86_64-unknown-linux-gnu"
    sys.exit(f"no Tectonic build for {system} {machine}")


def main() -> None:
    target = sys.argv[1] if len(sys.argv) > 1 else this_target()
    if target not in ARCHIVES:
        sys.exit(f"unknown target {target}; pick one of {', '.join(ARCHIVES)}")
    ext = ARCHIVES[target]
    name = f"tectonic-{VERSION}-{target}.{ext}"
    url = f"{BASE}/tectonic%40{VERSION}/{name}"
    print(f"Downloading {url}")
    with urllib.request.urlopen(url) as response:
        data = response.read()

    exe = "tectonic.exe" if "windows" in target else "tectonic"
    # Python's own tarfile and zipfile, so it works the same on every OS.
    if ext == "zip":
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            member = next(m for m in z.namelist() if Path(m).name == exe)
            binary = z.read(member)
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as t:
            member = next(m for m in t.getmembers() if Path(m.name).name == exe)
            binary = t.extractfile(member).read()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / exe
    out.write_bytes(binary)
    out.chmod(out.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    print(f"Saved {out}")


if __name__ == "__main__":
    main()
