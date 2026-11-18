"""阅屿 · Folio 桌面入口。

启动一个只监听本机的 FastAPI 服务，通过系统 WebView 显示前端。
"""
from __future__ import annotations

import argparse
import ctypes
import json
import logging
import multiprocessing
import os
import socket
import sys
import threading
import time
from http.client import HTTPConnection
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
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Folio"
    return root / "data"


def ensure_writable(directory: Path) -> None:
    marker = directory / f".folio-write-check-{os.getpid()}"
    try:
        directory.mkdir(parents=True, exist_ok=True)
        marker.write_text("ok", encoding="utf-8")
        marker.unlink()
    except OSError as exc:
        message = f"Folio 数据目录不可写：{directory}"
        if os.name == "nt":
            message += "\n请把 Folio 完整解压到桌面、文档或其他可写目录后再运行。"
        raise RuntimeError(message) from exc


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
    title = f"{APP_NAME} 无法启动"
    if os.name == "nt":
        ctypes.windll.user32.MessageBoxW(None, message, title, 0x10)
        return
    if sys.platform == "darwin":
        try:
            from AppKit import NSAlert, NSAlertStyleCritical, NSApplication

            NSApplication.sharedApplication()
            alert = NSAlert.alloc().init()
            alert.setAlertStyle_(NSAlertStyleCritical)
            alert.setMessageText_(title)
            alert.setInformativeText_(message)
            alert.runModal()
            return
        except Exception:
            logging.getLogger("folio.desktop").exception("could not display startup alert")
    if sys.stderr is not None:
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


def acquire_single_instance(data_dir: Path):
    """Hold the instance lock for the lifetime of the desktop app."""
    if sys.platform == "darwin":
        import fcntl

        lock = (data_dir / ".folio.lock").open("a")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock.close()
            return None
        except OSError:
            lock.close()
            raise
        return lock
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
    if handle in (None, True):
        return
    if sys.platform == "darwin":
        handle.close()
    elif os.name == "nt":
        ctypes.windll.kernel32.CloseHandle(handle)


def port_is_available(port: int) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        # Match Uvicorn's listener options. A completed HTTP connection may
        # still be in TIME_WAIT after the previous Folio instance has quit.
        if sys.platform != "win32":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
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

    def _run(self) -> None:
        try:
            self.server.run()
        except (Exception, SystemExit):
            logging.getLogger("folio.desktop").exception("local server stopped during startup")

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
        self.thread = threading.Thread(target=self._run, name="folio-local-server", daemon=True)
        self.thread.start()

        deadline = time.monotonic() + STARTUP_TIMEOUT
        last_error = None
        while time.monotonic() < deadline:
            if not self.thread.is_alive():
                break
            connection = HTTPConnection(HOST, self.port, timeout=0.5)
            try:
                connection.request("GET", "/")
                with connection.getresponse() as response:
                    if response.status == 200:
                        return
            except OSError as exc:  # service is still starting
                last_error = exc
            finally:
                connection.close()
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


def configure_mac_window(window, server_url: str, data_dir: Path):
    """Install the Mac menu and expose a fixed application data location."""
    from AppKit import NSApp, NSColor, NSEventModifierFlagCommand, NSWindow, NSWorkspace
    from Foundation import NSBundle, NSURL
    from PyObjCTools import AppHelper
    from webview import FileDialog
    from webview.menu import Menu, MenuAction
    updater = None

    def check_for_updates() -> None:
        # The menu callback may run on a worker thread. Sparkle and AppKit
        # must be initialized and used on the main thread.
        def check():
            nonlocal updater
            from AppKit import NSAlert
            import objc

            bundle = NSBundle.mainBundle()
            feed = bundle.objectForInfoDictionaryKey_("SUFeedURL")
            if feed:
                try:
                    if updater is None:
                        location = Path(str(bundle.bundlePath())) / "Contents/Frameworks/Sparkle.framework"
                        framework = NSBundle.bundleWithPath_(str(location))
                        if framework is None or not framework.load():
                            raise RuntimeError("Could not load the Sparkle framework")
                        controller = objc.lookUpClass("SPUStandardUpdaterController")
                        updater = controller.alloc().initWithStartingUpdater_updaterDelegate_userDriverDelegate_(
                            True, None, None)
                    updater.checkForUpdates_(None)
                    return
                except Exception:
                    logging.getLogger("folio.desktop").exception("Could not start the update checker")
                    message = "无法启动更新检查，请在“设置 → 存储管理”中找到日志目录查看详情。"
            else:
                message = "此安装包尚未配置更新来源。"
            notice = NSAlert.alloc().init()
            notice.setMessageText_("检查更新")
            notice.setInformativeText_(message)
            notice.runModal()

        AppHelper.callAfter(check)

    def send_command(command: str, *args) -> None:
        arguments = ", ".join(json.dumps(arg, ensure_ascii=True) for arg in (command, *args))
        window.run_js(f"window.folioMenuCommand?.({arguments})")

    def open_documents() -> None:
        import httpx
        from main import MAX_PDF

        paths = window.create_file_dialog(FileDialog.OPEN, allow_multiple=True, file_types=("PDF 文档 (*.pdf)",))
        if not paths:
            return

        hashes = []
        with httpx.Client(base_url=server_url, timeout=180, trust_env=False) as client:
            for selected in paths:
                path = Path(selected)
                try:
                    if not path.is_file() or path.suffix.lower() != ".pdf" or path.stat().st_size > MAX_PDF:
                        continue
                    with path.open("rb") as stream:
                        reply = client.post("/api/parse", files={"file": (path.name, stream, "application/pdf")})
                    reply.raise_for_status()
                    hashes.append(reply.json()["pdf_hash"])
                except (OSError, httpx.HTTPError, ValueError, KeyError):
                    continue
        send_command("imported", {"hashes": hashes, "failed": len(paths) - len(hashes), "total": len(paths)})

    def reveal_data_dir() -> bool:
        origin = window.get_current_url()
        if not origin or (origin != server_url and not origin.startswith(server_url + "/")) or not data_dir.is_dir():
            return False
        AppHelper.callAfter(NSWorkspace.sharedWorkspace().openURL_, NSURL.fileURLWithPath_isDirectory_(str(data_dir), True))
        return True

    def set_menu_shortcuts() -> None:
        # pywebview builds the native items but doesn't expose key equivalents.
        menu = NSApp.mainMenu()
        if menu is None:
            return
        for item in menu.itemArray():
            submenu = item.submenu()
            if submenu is None:
                continue
            for title, shortcut in (("打开 PDF…", "o"), ("关闭论文标签", "w"), ("设置…", ",")):
                action = submenu.itemWithTitle_(title)
                if action is not None:
                    action.setKeyEquivalent_(shortcut)
                    action.setKeyEquivalentModifierMask_(NSEventModifierFlagCommand)

    def use_system_window_background() -> None:
        if isinstance(window.native, NSWindow):
            window.native.setBackgroundColor_(NSColor.windowBackgroundColor())

    window.expose(reveal_data_dir)
    window.events.before_show += use_system_window_background
    window.events.loaded += lambda: AppHelper.callAfter(set_menu_shortcuts)
    return [
        Menu("__app__", [
            MenuAction("设置…", lambda: send_command("settings")),
            MenuAction("检查更新…", check_for_updates),
        ]),
        Menu("文件", [
            MenuAction("打开 PDF…", open_documents),
            MenuAction("关闭论文标签", lambda: send_command("close")),
        ]),
    ]


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
        options = {}
        if sys.platform == "darwin":
            logger.info("starting WKWebView window")
            webview.settings["ALLOW_FILE_URLS"] = False
            options["menu"] = configure_mac_window(window, server.url, data_dir)
        else:
            logger.info("starting Edge WebView2 window")
            options = {
                "gui": "edgechromium",
                "storage_path": str(data_dir / "webview"),
                "icon": str(resource_path("frontend/assets/yueyu-glacier.ico")),
            }
        webview.start(debug=debug, private_mode=False, **options)
    finally:
        server.stop()


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=APP_NAME)
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
        mutex = acquire_single_instance(data_dir)
        if mutex is None:
            if os.environ.get("FOLIO_NO_DIALOG") != "1":
                show_error("阅屿 · Folio 已经在运行。")
            return 2
        log_path = configure_logging(data_dir)
        logging.getLogger("folio.desktop").info(
            "app root=%s data=%s frozen=%s", root, data_dir, bool(getattr(sys, "frozen", False))
        )
        run_desktop(data_dir, debug=args.debug)
        return 0
    except Exception as exc:
        detail = exception_text(exc)
        logging.getLogger("folio.desktop").error("desktop startup failed: %s", detail)
        if os.environ.get("FOLIO_NO_DIALOG") != "1":
            message = str(exc) if isinstance(exc, RuntimeError) else detail
            show_error(f"{message}\n\n诊断日志：{log_path}")
        return 1
    finally:
        release_single_instance(mutex)


if __name__ == "__main__":
    raise SystemExit(main())
