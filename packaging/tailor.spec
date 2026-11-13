# PyInstaller build for Tailor. Run from the repository root after building the
# interface (npm run build in ui/) and fetching Tectonic:
#
#     uv run pyinstaller packaging/tailor.spec --noconfirm
#
# macOS gives dist/Tailor.app; Windows gives the dist/Tailor folder, which the
# Inno Setup script in packaging/windows turns into an installer.

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

ROOT = Path(SPECPATH).parent
MAC = sys.platform == "darwin"
WINDOWS = sys.platform == "win32"
VERSION = "0.1.0"

tectonic = ROOT / "packaging" / "bin" / ("tectonic.exe" if WINDOWS else "tectonic")
interface = ROOT / "ui" / "dist" / "index.html"
for needed in (tectonic, interface):
    if not needed.is_file():
        raise SystemExit(f"Missing {needed}. Fetch Tectonic and build the interface first.")

a = Analysis(
    [str(ROOT / "app" / "main.py")],
    pathex=[str(ROOT)],
    # Tectonic sits at the top of the bundle, where app.core.compile looks for it.
    binaries=[(str(tectonic), ".")],
    datas=[
        (str(interface), "ui"),
        (str(ROOT / "app" / "core" / "skills.txt"), "app/core"),
        *collect_data_files("docx"),
    ],
    # keyring finds its backends at runtime, so name the two the app uses.
    hiddenimports=["keyring.backends.macOS", "keyring.backends.Windows"],
    excludes=["tkinter"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Tailor",
    console=False,
    icon=str(ROOT / "packaging" / "icons" / ("icon.ico" if WINDOWS else "icon.icns")),
    target_arch="arm64" if MAC else None,
)
coll = COLLECT(exe, a.binaries, a.datas, name="Tailor")

if MAC:
    app = BUNDLE(
        coll,
        name="Tailor.app",
        icon=str(ROOT / "packaging" / "icons" / "icon.icns"),
        bundle_identifier="app.tailor.desktop",
        version=VERSION,
        info_plist={
            "CFBundleShortVersionString": VERSION,
            "NSHighResolutionCapable": True,
            "LSMinimumSystemVersion": "12.0",
        },
    )
