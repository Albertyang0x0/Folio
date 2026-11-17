"""阅屿 · Folio 后端服务（FastAPI）。

接口：
  POST /api/parse         上传 PDF，返回每页文字块（坐标/字号/样式）
  POST /api/translate_page 翻译某一页（带本地缓存）
  POST /api/export_pdf     生成译文 PDF
  GET  /api/storage        查看本机存储占用
  POST /api/clear_cache    清空翻译缓存
"""
import asyncio
import hashlib
import json
import logging
import os
import re
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
from translator import (DEFAULT_BASE_URL, DEFAULT_TRANSLATION_PROMPT, check_translation_connection, configured_model, configured_translation_prompt, translate_segments, _placeholder_order, _style_marker_order,
                        _valid_style_markup, _strip_style_markers, _is_nontranslatable, TranslationError, TranslationServiceError)
from library import PaperLibrary, valid_hash
from paper_overview import OVERVIEW_VERSION, generate_overview

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
CHUNK_SEGMENTS = 12
_BYLINE = re.compile(r"[^\W\d_][\w.'’\-]*(?: +[^\W\d_][\w.'’\-]*){1,5} *[*∗†‡]+", re.UNICODE)
EXTRACT_VER = 30  # 跨文本块的公式行及对齐的定义行
PROMPT_VER = 7    # 翻译协议保护并校验成对的局部样式标记


class TranslateReq(BaseModel):
    pdf_hash: str
    page: int
    force: bool = False
    settings: dict = {}
    cached_only: bool = False  # 仅命中缓存时返回，不触发真实翻译（页面加载时预热用）


class ExportReq(BaseModel):
    pdf_hash: str
    items: list = []


class OverviewReq(BaseModel):
    pdf_hash: str
    settings: dict = {}


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
    records = _files_stats(library.directory.rglob("*.json"))
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


class LibraryPresentationReq(BaseModel):
    display_title: str | None = None
    archived: bool | None = None


@app.post("/api/library/{pdf_hash}/presentation")
def api_library_presentation(pdf_hash: str, req: LibraryPresentationReq):
    try:
        return library.edit_presentation(pdf_hash, req.display_title, req.archived)
    except KeyError as exc:
        raise HTTPException(404, "论文已不在库中，请重新载入论文库") from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(500, "论文信息未保存，请检查本地数据目录是否可写") from exc


def _library_entry(digest, file_name, restore=False):
    # Library errors must not block opening/reading an otherwise valid PDF.
    try:
        record = library.register(digest, file_name)
        return {"library_entry": library.present(record, restore=restore)}
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
    # Retain valid translations for blocks with identical inputs, including
    # when a newly eligible caption or section changes the rest of its page.
    try:
        _migrate_translation_cache(pdf_hash, old_meta.get("extract_ver"), old_pages, pages)
    except (ValueError, OSError, TypeError, KeyError):
        pass
    return pages, outline


_RENDER_TOKEN = re.compile(r"__MATH_\d{4,}__|__STYLE_\d{4,}_(?:OPEN|CLOSE)__")


def _render_tokens(block):
    tokens = [math["token"] for math in block.get("inline_math", [])]
    for style in block.get("inline_styles", []):
        tokens.extend(style["token"][:-2] + suffix for suffix in ("_OPEN__", "_CLOSE__"))
    return tokens


def _translation_signature(block):
    # Token IDs are page-local. An extra styled span on one line can renumber
    # every later paragraph without changing its text or formatting.
    aliases = {token: f"\0{i}\0" for i, token in enumerate(_render_tokens(block))}
    source = block.get("translation_text", block["text"])
    return (block["text"], _RENDER_TOKEN.sub(lambda m: aliases.get(m[0], m[0]), source),
            bool(block.get("math")), bool(block.get("skip")),
            tuple(math["text"] for math in block.get("inline_math", [])),
            tuple((bool(style.get("bold")), bool(style.get("italic")))
                  for style in block.get("inline_styles", [])))


def _migrate_translation_cache(pdf_hash, old_version, old_pages, pages):
    if old_version is None or old_version == EXTRACT_VER:
        return
    prefix = f"{old_version}|{PROMPT_VER}|"
    with _cache_lock:
        cache = _load_cache(pdf_hash)
        changed = False
        for key, values in list(cache.items()):
            versioned_key = key.removeprefix("partial|")
            if not versioned_key.startswith(prefix):
                continue
            fields = versioned_key.split("|", 4)
            if len(fields) != 5 or not fields[2].isdigit():
                continue
            page_no = int(fields[2])
            if not 0 <= page_no < min(len(old_pages), len(pages)):
                continue
            old_page, new_page = old_pages[page_no], pages[page_no]
            old_blocks, new_blocks = old_page["blocks"], new_page["blocks"]
            if not isinstance(values, list) or len(values) != len(old_blocks):
                continue
            new_key = f"{EXTRACT_VER}|" + versioned_key.split("|", 1)[1]
            if new_key in cache:
                continue
            old_signatures = [_translation_signature(block) for block in old_blocks]
            new_signatures = [_translation_signature(block) for block in new_blocks]
            if old_signatures == new_signatures:
                matches = enumerate(zip(old_blocks, values))
            else:
                by_source = {(sign, tuple(b["bbox"])): (b, value)
                             for sign, b, value in zip(old_signatures, old_blocks, values)}
                matches = ((i, by_source.get((sign, tuple(b["bbox"])), (None, None)))
                           for i, (sign, b) in enumerate(zip(new_signatures, new_blocks)))
            partial_key = "partial|" + new_key
            prior = cache.get(partial_key)
            migrated = [None] * len(new_blocks)
            if isinstance(prior, list) and len(prior) == len(new_blocks):
                migrated = [t if _valid_formula_tokens([b], [t]) else None for b, t in zip(new_blocks, prior)]
            for i, (old_block, value) in matches:
                if migrated[i] is not None or old_block is None or not _valid_formula_tokens([old_block], [value]):
                    continue
                block = new_blocks[i]
                token_map = dict(zip(_render_tokens(old_block), _render_tokens(block)))
                value = _RENDER_TOKEN.sub(lambda m: token_map.get(m[0], m[0]), value)
                source = block.get("translation_text", block["text"])
                if (value == source and not (block.get("math") or block.get("skip"))
                        and ("中文" in fields[4] or "chinese" in fields[4].lower())
                        and not _is_nontranslatable(source, fields[4])):
                    continue
                if _valid_formula_tokens([block], [value]):
                    migrated[i] = value
            if _valid_formula_tokens(new_blocks, migrated):
                cache[new_key] = migrated
                cache.pop(partial_key, None)
            elif any(t is not None and not (b.get("math") or b.get("skip")) for b, t in zip(new_blocks, migrated)):
                cache[partial_key] = migrated
            else:
                continue
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
            **_library_entry(digest, file.filename or "document.pdf", restore=True)}


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
        plain = _strip_style_markers(plain)
        item = {"id": block["id"], "text": plain}
        if plain != translated:
            item["rich_text"] = translated
        output.append(item)
    return output


def _valid_formula_tokens(blocks, translations):
    return (isinstance(translations, list) and len(blocks) == len(translations) and all(
        isinstance(t, str) and bool(t.strip())
        and Counter(m["token"] for m in b.get("inline_math", [])) == Counter(_placeholder_order(t))
        and Counter(_style_marker_order(b.get("translation_text", b.get("text", "")))) == Counter(_style_marker_order(t))
        and _valid_style_markup(t)
        for b, t in zip(blocks, translations)))


def _translation_cache_key(page, settings):
    base, model = configured_model(settings)
    target = settings.get("target") or "简体中文"
    key = f"{EXTRACT_VER}|{PROMPT_VER}|{page}|{model}|{target}"
    if base.lower() not in {DEFAULT_BASE_URL, f"{DEFAULT_BASE_URL}/v1"}:
        key += "|endpoint=" + hashlib.sha256(base.encode()).hexdigest()[:16]
    # The default can change without changing the protocol or saved overrides.
    prompt = configured_translation_prompt(settings)
    return key + "|prompt=" + hashlib.sha256(prompt.encode()).hexdigest()


@app.get("/api/translation_prompt")
def api_translation_prompt():
    return {"default": DEFAULT_TRANSLATION_PROMPT}


@app.post("/api/translation_connection")
async def api_translation_connection(settings: dict):
    try:
        await check_translation_connection(settings)
    except TranslationServiceError as exc:
        return JSONResponse(status_code=422, content=exc.failure)
    return {"ok": True}


def _overview_path(pdf_hash):
    if not valid_hash(pdf_hash) or not _pages_path(pdf_hash).is_file():
        raise HTTPException(404, "论文未找到，请重新打开 PDF")
    return CACHE_DIR / f"{pdf_hash}.overview.json"


def _read_overview(path):
    try:
        cached = json.loads(path.read_text(encoding="utf-8"))
        if (cached.get("version") == OVERVIEW_VERSION and cached.get("extract_ver") == EXTRACT_VER
                and isinstance(cached.get("overview"), dict)):
            return cached["overview"]
    except (OSError, ValueError, AttributeError):
        pass
    return None


_overview_jobs = {}


@app.get("/api/paper_overview/{pdf_hash}")
def api_cached_overview(pdf_hash: str):
    return {"overview": _read_overview(_overview_path(pdf_hash))}


async def _build_overview(pdf_hash, settings, path):
    try:
        overview = await generate_overview(_load_pages(pdf_hash), settings)
        try:
            with _cache_lock:
                PaperLibrary._write_json(path, {"version": OVERVIEW_VERSION, "extract_ver": EXTRACT_VER,
                                                "overview": overview})
        except OSError:
            logger.warning("Could not store paper overview")
        return {"overview": overview}
    except TranslationServiceError as exc:
        return JSONResponse(status_code=422, content=exc.failure)
    finally:
        _overview_jobs.pop(pdf_hash, None)


@app.post("/api/paper_overview")
async def api_paper_overview(req: OverviewReq):
    path = _overview_path(req.pdf_hash)
    cached = _read_overview(path)
    if cached is not None:
        return {"overview": cached}
    task = _overview_jobs.get(req.pdf_hash)
    if task is None:
        task = _overview_jobs[req.pdf_hash] = asyncio.create_task(
            _build_overview(req.pdf_hash, req.settings, path))
    return await asyncio.shield(task)


class CachedTranslationsReq(BaseModel):
    pdf_hash: str
    settings: dict = {}


@app.post("/api/cached_translations")
def api_cached_translations(req: CachedTranslationsReq):
    if not valid_hash(req.pdf_hash):
        raise HTTPException(400, "无效的论文编号")
    pages = _load_pages(req.pdf_hash)
    cache = _load_cache(req.pdf_hash)
    result = []
    for page, meta in enumerate(pages):
        key = _translation_cache_key(page, req.settings)
        blocks = meta["blocks"]
        values = cache.get(key) or cache.get("partial|" + key)
        if not isinstance(values, list) or len(values) != len(blocks):
            continue
        searchable = [(block, value) for block, value in zip(blocks, values)
                      if not (block.get("skip") or block.get("math")) and _valid_formula_tokens([block], [value])]
        if searchable:
            selected_blocks, selected_values = zip(*searchable)
            result.append({"page": page, "blocks": _translation_blocks(selected_blocks, selected_values)})
    return {"pages": result}


@app.post("/api/translate_page")
async def api_translate_page(req: TranslateReq):
    if not valid_hash(req.pdf_hash):
        raise HTTPException(400, "无效的论文编号")
    pages = _load_pages(req.pdf_hash)
    if not (0 <= req.page < len(pages)):
        raise HTTPException(404, "页码超出范围")
    blocks = pages[req.page]["blocks"]
    if not blocks:
        return {"page": req.page, "blocks": [], "cached": True}
    target = req.settings.get("target") or "简体中文"
    cache = _load_cache(req.pdf_hash)
    key = _translation_cache_key(req.page, req.settings)
    if not req.force and key in cache and _valid_formula_tokens(blocks, cache[key]):
        return {
            "page": req.page,
            "blocks": _translation_blocks(blocks, cache[key]),
            "cached": True,
        }
    if req.cached_only:
        values = cache.get("partial|" + key)
        partial = []
        if isinstance(values, list) and len(values) == len(blocks):
            values = [value if _valid_formula_tokens([block], [value]) else None
                      for block, value in zip(blocks, values)]
            partial = _translation_blocks(blocks, values)
        return {"page": req.page, "blocks": partial, "cached": False, "complete": False}
    # 公式、表格、算法块不翻译，保持原文
    translate_idx = [i for i, b in enumerate(blocks) if not b.get("math") and not b.get("skip")]
    results = [None if i in translate_idx else b["text"] for i, b in enumerate(blocks)]
    if req.page == 0:
        abstract = next((b for b in blocks if re.match(r"^\s*(a\s*bstract|summary)\b", b["text"], re.I)), None)
        if abstract:
            preceding = [b for b in blocks if b["bbox"][3] < abstract["bbox"][1]]
            title_size = max((b["font_size"] for b in preceding), default=0)
            title_bottom = max((b["bbox"][3] for b in preceding if b["font_size"] == title_size), default=0)
            for i in translate_idx:
                b = blocks[i]
                names = re.sub(r"\S+@\S+|\[[\d\s−–-]+\]|\d+|[*∗†‡,;]", " ", b["text"])
                words = re.findall(r"[^\W\d_][\w.'’\-]*", names, re.UNICODE)
                author_line = (2 <= len(words) <= 80 and all(w[0].isupper() or w == "and" for w in words)
                               and not re.search(r"[:?!]|\b(?:University|Institute|School|Department|Laboratory|Abstract)\b", names)
                               and b["bbox"][1] >= title_bottom)
                if b["bbox"][3] < abstract["bbox"][1] and (author_line or _BYLINE.fullmatch(b["text"].strip())):
                    results[i] = b.get("translation_text", b["text"])
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
        while end < len(pending) and len(segments) < CHUNK_SEGMENTS:
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
            reason = next((f for f in exc.failures.values()
                           if f["code"] in {"timeout", "network", "service_error", "tls_setup"} or f["code"].startswith("upstream_")), None)
            stop = reason is not None
            if stop:
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
    """Delete regenerable translations and paper overviews."""
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
        raise HTTPException(500, f"有 {failed} 个缓存文件未能清理，请检查数据目录是否可写")
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
