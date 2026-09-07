# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller onedir build for the Windows portable desktop release."""
from pathlib import Path


project_root = Path(SPECPATH).resolve()

a = Analysis(
    [str(project_root / "backend" / "desktop.py")],
    pathex=[str(project_root / "backend")],
    binaries=[],
    datas=[(str(project_root / "frontend"), "frontend")],
    hiddenimports=[
        "clr",
        "webview",
        "webview.platforms.edgechromium",
        "uvicorn.logging",
        "uvicorn.loops", "uvicorn.loops.auto", "uvicorn.loops.asyncio",
        "uvicorn.protocols", "uvicorn.protocols.http", "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl", "uvicorn.protocols.http.httptools_impl",
        "uvicorn.protocols.websockets", "uvicorn.protocols.websockets.auto",
        "uvicorn.protocols.websockets.websockets_impl", "uvicorn.protocols.websockets.wsproto_impl",
        "uvicorn.lifespan", "uvicorn.lifespan.on", "uvicorn.lifespan.off",
        "pymupdf", "httptools", "websockets",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter", "PyQt5", "PyQt6", "PySide2", "PySide6",
        "gi", "cefpython3", "kivy",
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Folio",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=True,
    icon=str(project_root / "frontend" / "assets" / "yueyu-glacier.ico"),
    version=str(project_root / "packaging" / "version_info.txt"),
)

bundle = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="Folio",
)
