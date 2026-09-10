"""阅屿 · Folio 后端服务（FastAPI）。

接口：
  POST /api/parse         上传 PDF，返回每页文字块（坐标/字号/样式）
  POST /api/translate_page 翻译某一页（带本地缓存）
  POST /api/export_pdf     生成译文 PDF
  GET  /api/storage        查看本机存储占用
  POST /api/clear_cache    清空翻译缓存
"""
import hashlib
import json
import logging
import os
import shutil
import sys
import threading
from collections import Counter
from pathlib import Path

import fitz
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from exporter import build_translated_pdf
from extraction import extract_pages
from translator import translate_segments, _placeholder_order, TranslationError
from library import PaperLibrary, valid_hash

if getattr(sys, "frozen", False):
    # PyInstaller 打包运行：exe 所在目录放数据（可写），资源目录放前端静态文件
    _EXE_DIR = Path(sys.executable).resolve().parent
    BASE_DIR = _EXE_DIR
    FRONTEND_DIR = Path(getattr(sys, "_MEIPASS", _EXE_DIR)) / "frontend"
else:
    BASE_DIR = Path(__file__).resolve().parent.parent
    FRONTEND_DIR = BASE_DIR / "frontend"
_DATA_OVERRIDE = os.environ.get("FOLIO_DATA_DIR", "").strip()
DATA_DIR = Path(_DATA_OVERRIDE).expanduser().resolve() if _DATA_OVERRIDE else BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
CACHE_DIR = DATA_DIR / "cache"
for _d in (DATA_DIR, UPLOAD_DIR, CACHE_DIR):
    _d.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="阅屿 · Folio")
_cache_lock = threading.Lock()
logger = logging.getLogger("folio.translation")
library = PaperLibrary(DATA_DIR / "library", UPLOAD_DIR)


@app.middleware("http")
async def _no_cache_static(request, call_next):
    """开发期静态资源不缓存，避免前端改动后浏览器仍显示旧版。"""
    response = await call_next(request)
    path = request.url.path
    if not path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response

MAX_PDF = 80 * 1024 * 1024
CHUNK_CHARS = 6000  # 每次请求最多送这么多字符去翻译
EXTRACT_VER = 18  # 支持长分组表格、罗马数字表号和科学计数法表体
PROMPT_VER = 6    # 新校验兼容已有合格译文；保留版本以迁移内容未变的页缓存


class TranslateReq(BaseModel):
    pdf_hash: str
    page: int
    force: bool = False
    settings: dict = {}
    cached_only: bool = False  # 仅命中缓存时返回，不触发真实翻译（页面加载时预热用）


class ExportReq(BaseModel):
    pdf_hash: str
    items: list = []


class ReadingReq(BaseModel):
    reading: dict
    updated_at: float
    last_read: float


class MigrateReq(BaseModel):
    entries: list = []


def _files_stats(paths):
    """Return the readable regular-file count and size without following directories."""
    count = size = 0
    for path in paths:
        try:
            if path.is_file():
                count += 1
                size += path.stat().st_size
        except OSError:
            continue
    return {"bytes": size, "files": count}


def _storage_snapshot():
    papers = _files_stats(UPLOAD_DIR.glob("*.pdf"))
    extracted = _files_stats(list(UPLOAD_DIR.glob("*.pages.json")) + list(UPLOAD_DIR.glob("*.meta.json")))
    translations = _files_stats(CACHE_DIR.glob("*.json"))
    records = _files_stats(library.directory.glob("*.json"))
    classified_bytes = papers["bytes"] + extracted["bytes"] + translations["bytes"] + records["bytes"]
    classified_files = papers["files"] + extracted["files"] + translations["files"] + records["files"]
    total_stats = _files_stats(DATA_DIR.rglob("*"))
    total = total_stats["bytes"]
    try:
        disk = shutil.disk_usage(DATA_DIR)
        free = disk.free
    except OSError:
        free = None
    return {
        "data_dir": str(DATA_DIR.resolve()),
        "total_bytes": total,
        "free_bytes": free,
        "desktop_mode": os.environ.get("FOLIO_DESKTOP") == "1",
        "categories": {
            "papers": papers,
            "extracted": extracted,
            "translations": translations,
            "records": records,
            # Desktop WebView2 profile, logs and future small application files.
            "other": {
                "bytes": max(0, total - classified_bytes),
                "files": max(0, total_stats["files"] - classified_files),
            },
        },
    }


@app.get("/api/library")
def api_library():
    return library.list()


@app.get("/api/storage")
def api_storage():
    """Small read-only storage overview for the local library manager."""
    with _cache_lock:
        return _storage_snapshot()


@app.post("/api/library/migrate")
def api_library_migrate(req: MigrateReq):
    if len(req.entries) > 10000 or any(not isinstance(e, dict) for e in req.entries):
        raise HTTPException(400, "旧阅读记录格式错误")
    try:
        return library.migrate(req.entries)
    except (ValueError, OSError) as exc:
        raise HTTPException(500, "论文库迁移未完成，旧记录已保留") from exc


@app.post("/api/library/{pdf_hash}/reading")
def api_library_reading(pdf_hash: str, req: ReadingReq):
    try:
        return library.save(pdf_hash, req.reading, req.updated_at, req.last_read)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(500, "阅读状态未保存，请检查本地数据目录是否可写") from exc


def _library_entry(digest, file_name):
    # Library errors must not block opening/reading an otherwise valid PDF.
    try:
        return {"library_entry": library.register(digest, file_name)}
    except (ValueError, OSError, RuntimeError):
        return {"library_error": "论文库信息未保存，请检查本地数据目录或重试"}


def _pages_path(pdf_hash):
    return UPLOAD_DIR / f"{pdf_hash}.pages.json"


def _load_pages(pdf_hash):
    p = _pages_path(pdf_hash)
    if not p.exists():
        raise HTTPException(404, "请先上传解析 PDF")
    return json.loads(p.read_text(encoding="utf-8"))


def _load_cache(pdf_hash):
    p = CACHE_DIR / f"{pdf_hash}.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _outline(doc):
    """读取 PDF 自带大纲（书签目录）。返回 [[level, title, page], ...]，page 为 1 基。"""
    try:
        toc = doc.get_toc(simple=True) or []
    except Exception:
        toc = []
    out = []
    for item in toc:
        try:
            level, title, page = int(item[0]), str(item[1]), int(item[2])
        except Exception:
            continue
        out.append([level, title, page])
    return out


def _meta_path(pdf_hash):
    return UPLOAD_DIR / f"{pdf_hash}.meta.json"


def _save_meta(pdf_hash, file_name, outline):
    (_meta_path(pdf_hash)).write_text(
        json.dumps({"file_name": file_name, "outline": outline, "extract_ver": EXTRACT_VER}, ensure_ascii=False),
        encoding="utf-8",
    )


def _re_extract(pdf_hash, pdf_data=None, file_name="document.pdf"):
    """按当前提取算法重新解析 PDF，写回 pages.json 与 meta；返回 (pages, outline)。"""
    old_meta = _load_meta(pdf_hash) or {}
    try:
        old_pages = _load_pages(pdf_hash)
    except (HTTPException, ValueError, OSError):
        old_pages = []
    if pdf_data is not None:
        doc = fitz.open(stream=pdf_data, filetype="pdf")
    else:
        pdf_path = UPLOAD_DIR / f"{pdf_hash}.pdf"
        if not pdf_path.exists():
            raise HTTPException(404, "原文件不存在，请重新上传")
        doc = fitz.open(pdf_path)
    try:
        pages = extract_pages(doc)
        outline = _outline(doc)
    finally:
        doc.close()
    (UPLOAD_DIR / f"{pdf_hash}.pdf").write_bytes(pdf_data) if pdf_data is not None else None
    _pages_path(pdf_hash).write_text(json.dumps(pages, ensure_ascii=False), encoding="utf-8")
    _save_meta(pdf_hash, file_name, outline)
    # Only reuse a page when its translation inputs are identical. Geometry-only
    # fixes need no provider call; changed paragraph/token structure must miss.
    # Keep the old namespace intact instead of deleting all previous translations.
    try:
        _migrate_unchanged_cache(pdf_hash, old_meta.get("extract_ver"), old_pages, pages)
    except (ValueError, OSError, TypeError, KeyError):
        pass
    return pages, outline


def _translation_signature(page):
    return [(b["text"], b.get("translation_text", b["text"]), bool(b.get("math")), bool(b.get("skip")),
             [(m["token"], m["text"]) for m in b.get("inline_math", [])])
            for b in page["blocks"]]


def _migrate_unchanged_cache(pdf_hash, old_version, old_pages, pages):
    if old_version is None or old_version == EXTRACT_VER:
        return
    unchanged = {i for i, (old, new) in enumerate(zip(old_pages, pages))
                 if _translation_signature(old) == _translation_signature(new)}
    prefix = f"{old_version}|{PROMPT_VER}|"
    with _cache_lock:
        cache = _load_cache(pdf_hash)
        changed = False
        for key, values in list(cache.items()):
            if not key.startswith(prefix):
                continue
            fields = key.split("|", 4)
            if len(fields) != 5 or not fields[2].isdigit():
                continue
            page_no = int(fields[2])
            if page_no not in unchanged or not _valid_formula_tokens(pages[page_no]["blocks"], values):
                continue
            new_key = str(EXTRACT_VER) + "|" + key.split("|", 1)[1]
            if new_key not in cache:
                cache[new_key] = values
                changed = True
        if changed:
            (CACHE_DIR / f"{pdf_hash}.json").write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")


def _load_meta(pdf_hash):
    p = _meta_path(pdf_hash)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.post("/api/parse")
async def api_parse(file: UploadFile = File(...)):
    data = await file.read()
    if len(data) > MAX_PDF:
        raise HTTPException(413, "PDF 文件过大（超过 80MB）")
    digest = hashlib.sha256(data).hexdigest()
    pages_path = _pages_path(digest)
    if not pages_path.exists():
        try:
            doc = fitz.open(stream=data, filetype="pdf")
        except Exception as exc:
            raise HTTPException(400, f"无法解析 PDF 文件: {exc}")
        try:
            pages = extract_pages(doc)
            outline = _outline(doc)
        finally:
            doc.close()
        (UPLOAD_DIR / f"{digest}.pdf").write_bytes(data)
        pages_path.write_text(json.dumps(pages, ensure_ascii=False), encoding="utf-8")
        _save_meta(digest, file.filename or "document.pdf", outline)
    else:
        meta = _load_meta(digest) or {}
        if meta.get("extract_ver") != EXTRACT_VER:
            # 提取算法已更新，强制重新提取
            try:
                pages, outline = _re_extract(digest, pdf_data=data, file_name=file.filename or "document.pdf")
            except Exception as exc:
                raise HTTPException(400, f"无法解析 PDF 文件: {exc}")
        else:
            pages = json.loads(pages_path.read_text(encoding="utf-8"))
            outline = meta.get("outline", [])
    # Reimporting the same PDF also repairs a missing saved file without resetting its record.
    saved_pdf = UPLOAD_DIR / f"{digest}.pdf"
    if not saved_pdf.exists() or hashlib.sha256(saved_pdf.read_bytes()).hexdigest() != digest:
        saved_pdf.write_bytes(data)
    return {"pdf_hash": digest, "file_name": file.filename, "pages": pages, "outline": outline,
            **_library_entry(digest, file.filename or "document.pdf")}


@app.get("/api/doc/{pdf_hash}")
async def api_doc(pdf_hash: str):
    """重新打开已上传文档的元信息与页文本（供「最近打开」使用）。"""
    if not valid_hash(pdf_hash):
        raise HTTPException(400, "无效的论文标识")
    pages = _load_pages(pdf_hash)
    meta = _load_meta(pdf_hash) or {}
    if meta.get("extract_ver") != EXTRACT_VER:
        # 提取算法已更新，从已存 PDF 重新提取
        try:
            pages, outline = _re_extract(pdf_hash, file_name=meta.get("file_name", "document.pdf"))
            meta["outline"] = outline
            meta["file_name"] = meta.get("file_name", "document.pdf")
        except HTTPException:
            raise
        except Exception:
            pass  # 重新提取失败则用旧数据
    return {
        "pdf_hash": pdf_hash,
        "file_name": meta.get("file_name", "document.pdf"),
        "pages": pages,
        "outline": meta.get("outline", []),
        **_library_entry(pdf_hash, meta.get("file_name", "document.pdf")),
    }


@app.get("/api/reopen/{pdf_hash}")
async def api_reopen(pdf_hash: str):
    """返回已上传文档的 PDF 原始字节（供「最近打开」重新加载）。"""
    pdf_path = UPLOAD_DIR / f"{pdf_hash}.pdf"
    if not pdf_path.exists():
        raise HTTPException(404, "原文件已不存在，请重新上传")
    return Response(content=pdf_path.read_bytes(), media_type="application/pdf")


def _translation_blocks(blocks, translations):
    """text 保持旧 API 的可读纯文本契约，rich_text 供保真公式绘制。"""
    output = []
    for block, translated in zip(blocks, translations):
        if translated is None:
            continue  # Partial failures must not masquerade as English translations.
        plain = translated
        for formula in block.get("inline_math", []):
            plain = plain.replace(formula["token"], formula["text"])
        item = {"id": block["id"], "text": plain}
        if plain != translated:
            item["rich_text"] = translated
        output.append(item)
    return output


def _valid_formula_tokens(blocks, translations):
    return (isinstance(translations, list) and len(blocks) == len(translations) and all(
        isinstance(t, str) and bool(t.strip())
        and Counter(m["token"] for m in b.get("inline_math", [])) == Counter(_placeholder_order(t))
        for b, t in zip(blocks, translations)))


@app.post("/api/translate_page")
async def api_translate_page(req: TranslateReq):
    pages = _load_pages(req.pdf_hash)
    if not (0 <= req.page < len(pages)):
        raise HTTPException(404, "页码超出范围")
    blocks = pages[req.page]["blocks"]
    if not blocks:
        return {"page": req.page, "blocks": [], "cached": True}
    model = req.settings.get("model") or "deepseek-chat"
    target = req.settings.get("target") or "简体中文"
    cache = _load_cache(req.pdf_hash)
    key = f"{EXTRACT_VER}|{PROMPT_VER}|{req.page}|{model}|{target}"
    if not req.force and key in cache and _valid_formula_tokens(blocks, cache[key]):
        return {
            "page": req.page,
            "blocks": _translation_blocks(blocks, cache[key]),
            "cached": True,
        }
    if req.cached_only:
        return {"page": req.page, "blocks": [], "cached": False}
    # 公式、表格、算法块不翻译，保持原文
    translate_idx = [i for i, b in enumerate(blocks) if not b.get("math") and not b.get("skip")]
    results = [None if i in translate_idx else b["text"] for i, b in enumerate(blocks)]
    partial_key = "partial|" + key

    def reuse_partial(values):
        if isinstance(values, list) and len(values) == len(blocks):
            for i in translate_idx:
                if results[i] is None and _valid_formula_tokens([blocks[i]], [values[i]]):
                    results[i] = values[i]

    if not req.force:
        reuse_partial(cache.get(partial_key))
    pending = [i for i in translate_idx if results[i] is None]
    failures = {}
    fallback = {"code": "service_error", "message": "翻译未完成，请重试；若持续失败请查看后台错误代码", "retryable": True}
    start = 0
    while start < len(pending):
        end, total, segments = start, 0, []
        while end < len(pending):
            b = blocks[pending[end]]
            text = b.get("translation_text", b["text"])
            if segments and total + len(text) > CHUNK_CHARS:
                break
            segments.append(text)
            total += len(text)
            end += 1
        batch_idx = pending[start:end]
        stop = False
        try:
            values = await translate_segments(req.settings, segments, target)
        except TranslationError as exc:
            values = exc.results
            failures.update({batch_idx[i]: failure for i, failure in exc.failures.items() if i < len(batch_idx)})
            # Don't repeat a provider-wide failure against each later chunk.
            stop = any(f["code"] in {"timeout", "network", "service_error"} or f["code"].startswith("upstream_")
                       for f in exc.failures.values())
            if stop and exc.failures:
                reason = next(iter(exc.failures.values()))
                failures.update({i: reason for i in pending[end:]})
        except Exception as exc:
            # An arbitrary exception can include credentials/response bodies.
            # Log only its type; never return its raw string to the browser.
            logger.warning("translation exception page=%s type=%s", req.page + 1, type(exc).__name__)
            failures.update({i: fallback for i in pending[start:]})
            values = []
            stop = True
        if not isinstance(values, list):
            values = []
        for pos, i in enumerate(batch_idx):
            value = values[pos] if len(values) == len(batch_idx) else None
            if _valid_formula_tokens([blocks[i]], [value]):
                results[i] = value
                failures.pop(i, None)
            else:
                failures.setdefault(i, {"code": "invalid_translation", "message": "译文为空或公式标记不完整", "retryable": True})
        start = end
        if stop:
            break
    # Merge per-segment progress under the same lock as complete pages. A
    # partial record cannot overwrite a complete page or concurrent successes.
    with _cache_lock:
        cur = _load_cache(req.pdf_hash)
        if not req.force:
            reuse_partial(cur.get(key))
            reuse_partial(cur.get(partial_key))
        complete = _valid_formula_tokens(blocks, results)
        if complete:
            cur[key] = results
            cur.pop(partial_key, None)
        elif any(results[i] is not None for i in translate_idx):
            cur[partial_key] = results
        if complete or partial_key in cur:
            (CACHE_DIR / f"{req.pdf_hash}.json").write_text(
                json.dumps(cur, ensure_ascii=False), encoding="utf-8"
            )
    if not complete:
        failed = [{"id": blocks[i]["id"], **failures.get(i, fallback)} for i in translate_idx if results[i] is None]
        for failure in failed:
            logger.warning("translation incomplete pdf=%s page=%s block=%s code=%s",
                           req.pdf_hash[:12], req.page + 1, failure["id"], failure["code"])
        reasons = list(dict.fromkeys(f["message"] for f in failed))
        progress = ("已保留成功段落，重试只处理未完成部分。" if any(results[i] is not None for i in translate_idx)
                    else "本页正文尚未译完，请按上述原因检查后重试。")
        return JSONResponse(status_code=502, content={
            "page": req.page, "complete": False, "blocks": _translation_blocks(blocks, results),
            "failed_blocks": failed, "code": "translation_incomplete",
            "retryable": any(f["retryable"] for f in failed),
            "detail": "；".join(reasons) + "。" + progress,
        })
    return {
        "page": req.page,
        "complete": True,
        "blocks": _translation_blocks(blocks, results),
    }


@app.post("/api/export_pdf")
async def api_export_pdf(req: ExportReq):
    pdf_path = UPLOAD_DIR / f"{req.pdf_hash}.pdf"
    if not pdf_path.exists():
        raise HTTPException(404, "PDF 未找到，请重新上传")
    doc = fitz.open(pdf_path)
    try:
        build_translated_pdf(doc, req.items)
        buf = doc.tobytes(garbage=3, deflate=True)
    finally:
        doc.close()
    return Response(content=buf, media_type="application/pdf")


@app.post("/api/clear_cache")
def api_clear_cache():
    """Delete only regenerable translation results; never papers, notes or reading state."""
    freed = 0
    failed = 0
    with _cache_lock:
        for path in CACHE_DIR.glob("*.json"):
            try:
                size = path.stat().st_size
                path.unlink()
                freed += size
            except OSError:
                failed += 1
        snapshot = _storage_snapshot()
    if failed:
        raise HTTPException(500, f"有 {failed} 个翻译缓存文件未能清理，请检查数据目录是否可写")
    return {"ok": True, "freed_bytes": freed, "storage": snapshot}


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static")


def _free_port(preferred=8000):
    import socket

    for port in (preferred, 0):
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", port))
            chosen = s.getsockname()[1]
            s.close()
            return chosen
        except OSError:
            s.close()
            continue
    return 8000


if __name__ == "__main__":
    import os
    import threading
    import time
    import webbrowser

    import uvicorn

    port = int(os.environ.get("PORT") or 0) or _free_port()

    def _open_browser():
        time.sleep(1.2)
        webbrowser.open(f"http://127.0.0.1:{port}")

    threading.Thread(target=_open_browser, daemon=True).start()
    print(f"阅屿 · Folio 已启动：http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
