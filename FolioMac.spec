# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller onedir build for the macOS desktop application."""
import os
import ssl
from pathlib import Path


project_root = Path(SPECPATH).resolve()
icon = os.environ["FOLIO_MACOS_ICON"]
version = os.environ["FOLIO_VERSION"]
identity = os.environ.get("FOLIO_SIGN_IDENTITY") or None
resources = [(str(project_root / "frontend"), "frontend"), (str(project_root / "LICENSE"), ".")]
info = {
    "CFBundleDisplayName": "阅屿 · Folio",
    "CFBundleVersion": os.environ["FOLIO_BUILD_NUMBER"],
    "NSHighResolutionCapable": True,
}
if os.environ.get("FOLIO_UPDATE_FEED_URL"):
    info.update(
        SUFeedURL=os.environ["FOLIO_UPDATE_FEED_URL"],
        SUPublicEDKey=os.environ["FOLIO_UPDATE_PUBLIC_KEY"],
        SUEnableAutomaticChecks=False,
        SUVerifyUpdateBeforeExtraction=True,
        SURequireSignedFeed=True,
    )
    if info["SUFeedURL"].startswith("http://127.0.0.1:"):
        info["NSAppTransportSecurity"] = {"NSAllowsLocalNetworking": True}

# Some build interpreters read a distrust list adjacent to ssl.py when
# constructing a TLS context. Preserve that trust policy in the frozen app.
distrusted_ca_file = Path(ssl.__file__).with_name("codex-rejected-cas.pem")
if distrusted_ca_file.is_file():
    resources.append((str(distrusted_ca_file), "."))

a = Analysis(
    [str(project_root / "backend" / "desktop.py")],
    pathex=[str(project_root / "backend")],
    datas=resources,
    hiddenimports=[
        "webview.platforms.cocoa",
        "uvicorn.logging",
        "uvicorn.loops.auto", "uvicorn.loops.asyncio", "uvicorn.loops.uvloop",
        "uvicorn.protocols.http.auto", "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.http.httptools_impl",
        "uvicorn.protocols.websockets.auto", "uvicorn.protocols.websockets.websockets_impl",
        "uvicorn.protocols.websockets.websockets_sansio_impl",
        "uvicorn.protocols.websockets.wsproto_impl",
        "uvicorn.lifespan.on", "uvicorn.lifespan.off",
    ],
    excludes=["tkinter", "PyQt5", "PyQt6", "PySide2", "PySide6", "gi", "cefpython3", "kivy"],
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Folio",
    console=False,
    strip=False,
    upx=False,
    codesign_identity=identity,
)

collect = COLLECT(exe, a.binaries, a.datas, name="FolioMac", strip=False, upx=False)
app = BUNDLE(
    collect,
    name="Folio.app",
    icon=icon,
    bundle_identifier="io.github.albertyang0x0.folio",
    version=version,
    info_plist=info,
)
