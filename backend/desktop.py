"""阅屿 · Folio Windows 便携版桌面入口。

启动一个只监听本机的 FastAPI 服务，并用 Edge WebView2 显示现有前端。
程序、论文、缓存、笔记和窗口数据都保存在便携版文件夹内。
"""
from __future__ import annotations

import argparse
import ctypes
import logging
import multiprocessing
import os
import socket
import sys
import threading
import time
import urllib.request
from logging.handlers import RotatingFileHandler
from pathlib import Path


APP_NAME = "阅屿 · Folio"
APP_MUTEX = "Local\\YueyuFolioPortable-v1"
DEFAULT_PORT = 17865
HOST = "127.0.0.1"
STARTUP_TIMEOUT = 15.0


def portable_root() -> Path:
    """Return the folder users can move or copy as one portable unit."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def resource_path(relative: str) -> Path:
    """Resolve bundled read-only resources without mixing them with portable data."""
    base = Path(getattr(sys, "_MEIPASS", portable_root()))
    return base / relative


def configured_data_dir(root: Path) -> Path:
    override = os.environ.get("FOLIO_DATA_DIR", "").strip()
    return Path(override).expanduser().resolve() if override else root / "data"


def ensure_writable(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    marker = directory / f".folio-write-check-{os.getpid()}"
    try:
        marker.write_text("ok", encoding="utf-8")
        marker.unlink()
    except OSError as exc:
        raise RuntimeError(
            f"便携版目录不可写：{directory}\n"
            "请把 Folio 完整解压到桌面、文档或其他可写目录后再运行。"
        ) from exc


def configure_logging(data_dir: Path) -> Path:
    log_dir = data_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "folio.log"
    handler = RotatingFileHandler(log_path, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)
    root_logger.addHandler(handler)
    return log_path


def show_error(message: str) -> None:
    """Show startup failures even though the release executable has no console."""
    if os.name == "nt":
        ctypes.windll.user32.MessageBoxW(None, message, f"{APP_NAME} 无法启动", 0x10)
    else:
        print(message, file=sys.stderr)


def exception_text(exc: BaseException) -> str:
    """Format Python.NET exceptions without relying on a possibly broken ToString()."""
    details = [f"{type(exc).__module__}.{type(exc).__name__}"]
    for attr in ("Message", "Source", "HResult"):
        try:
            value = getattr(exc, attr, None)
        except Exception:
            value = None
        if value not in (None, ""):
            details.append(f"{attr}={value}")
    try:
        args = getattr(exc, "args", ())
        if args:
            details.append("args=" + repr(args))
    except Exception:
        pass
    try:
        inner = getattr(exc, "InnerException", None)
        if inner is not None:
            details.append("inner=" + exception_text(inner))
    except Exception:
        pass
    return " | ".join(map(str, details))


def acquire_single_instance():
    """Return a Windows mutex handle, or None when another Folio is running."""
    if os.name != "nt":
        return True
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_mutex = kernel32.CreateMutexW
    create_mutex.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    create_mutex.restype = ctypes.c_void_p
    handle = create_mutex(None, False, APP_MUTEX)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
        kernel32.CloseHandle(handle)
        return None
    return handle


def release_single_instance(handle) -> None:
    if os.name == "nt" and handle not in (None, True):
        ctypes.windll.kernel32.CloseHandle(handle)


def port_is_available(port: int) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind((HOST, port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


class LocalServer:
    def __init__(self, port: int):
        self.port = port
        self.server = None
        self.thread = None

    @property
    def url(self) -> str:
        return f"http://{HOST}:{self.port}"

    def start(self) -> None:
        if not port_is_available(self.port):
            raise RuntimeError(
                f"本机端口 {self.port} 正在被其他程序使用。\n"
                "请关闭已经运行的 Folio 或占用该端口的程序后重试。"
            )
        import uvicorn
        from main import app

        config = uvicorn.Config(
            app,
            host=HOST,
            port=self.port,
            log_level="warning",
            access_log=False,
            # Windowed PyInstaller apps have no stdout/stderr. Uvicorn's default
            # formatter probes stderr.isatty(), so use our rotating file logger.
            log_config=None,
        )
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.server.run, name="folio-local-server", daemon=True)
        self.thread.start()

        deadline = time.monotonic() + STARTUP_TIMEOUT
        last_error = None
        while time.monotonic() < deadline:
            if not self.thread.is_alive():
                break
            try:
                with urllib.request.urlopen(self.url + "/", timeout=0.5) as response:
                    if response.status == 200:
                        return
            except Exception as exc:  # service is still starting
                last_error = exc
                time.sleep(0.1)
        self.stop()
        raise RuntimeError(f"本机服务启动超时。{last_error or ''}".strip())

    def stop(self) -> None:
        if self.server is not None:
            self.server.should_exit = True
        if self.thread is not None and self.thread.is_alive():
            self.thread.join(timeout=8)
        if self.server is not None and self.thread is not None and self.thread.is_alive():
            self.server.force_exit = True
            self.thread.join(timeout=2)


def run_desktop(data_dir: Path, debug: bool = False) -> None:
    logger = logging.getLogger("folio.desktop")
    logger.info("loading desktop window runtime")
    try:
        import webview
    except ImportError as exc:
        raise RuntimeError("桌面窗口组件缺失，请重新构建便携版。") from exc

    logger.info("desktop window runtime loaded")
    server = LocalServer(int(os.environ.get("FOLIO_PORT", DEFAULT_PORT)))
    try:
        logger.info("starting local service on %s", server.url)
        server.start()
        logger.info("local service is ready")
        window = webview.create_window(
            APP_NAME,
            server.url,
            width=1440,
            height=900,
            min_size=(960, 640),
            resizable=True,
            background_color="#edf5fb",
            text_select=True,
        )
        if window is None:
            raise RuntimeError("桌面窗口创建失败")
        logger.info("starting Edge WebView2 window")
        webview.start(
            gui="edgechromium",
            debug=debug,
            private_mode=False,
            storage_path=str(data_dir / "webview"),
            icon=str(resource_path("frontend/assets/yueyu-glacier.ico")),
        )
    finally:
        server.stop()


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="阅屿 · Folio Windows 便携版")
    parser.add_argument("--debug", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def main(argv=None) -> int:
    multiprocessing.freeze_support()
    args = parse_args(argv)
    root = portable_root()
    data_dir = configured_data_dir(root)
    os.environ["FOLIO_DATA_DIR"] = str(data_dir)
    os.environ["FOLIO_DESKTOP"] = "1"
    mutex = None
    log_path = data_dir / "logs" / "folio.log"
    try:
        ensure_writable(data_dir)
        log_path = configure_logging(data_dir)
        logging.getLogger("folio.desktop").info(
            "portable root=%s data=%s frozen=%s", root, data_dir, bool(getattr(sys, "frozen", False))
        )
        mutex = acquire_single_instance()
        if mutex is None:
            show_error("阅屿 · Folio 已经在运行。")
            return 2
        run_desktop(data_dir, debug=args.debug)
        return 0
    except Exception as exc:
        detail = exception_text(exc)
        logging.getLogger("folio.desktop").error("desktop startup failed: %s", detail)
        if os.environ.get("FOLIO_NO_DIALOG") != "1":
            show_error(f"{detail}\n\n诊断日志：{log_path}")
        return 1
    finally:
        release_single_instance(mutex)


if __name__ == "__main__":
    raise SystemExit(main())
