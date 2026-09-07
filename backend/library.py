"""Local paper library. One atomically replaced record per PDF; no provider calls."""
import hashlib
import json
import math
import os
import re
import tempfile
import threading
import time
import unicodedata
from pathlib import Path

import fitz


TITLE_VERSION = 1


def valid_hash(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _clean_title(value):
    text = unicodedata.normalize("NFKC", str(value or "")).replace("\u00ad", "")
    text = re.sub(r"(?<=\w)-[ \t]*\n[ \t]*(?=\w)", "-", text)
    # Line wraps in Chinese titles do not denote word boundaries.
    text = re.sub(r"(?<=[\u3400-\u9fff])\s*\n\s*(?=[\u3400-\u9fff])", "", text)
    return re.sub(r"\s+", " ", text).strip()


def _usable_title(text):
    """Reject identifiers, export placeholders and publication boilerplate."""
    if not 2 <= len(text) <= 600 or not any(c.isalpha() for c in text) or "@" in text:
        return False
    if text.casefold() in {"untitled", "document", "paper", "main", "latex", "manuscript", "template",
                           "abstract", "introduction", "references", "summary", "摘要", "引言", "目录"}:
        return False
    if re.search(r"\.(?:pdf|docx?|tex|ps|dvi)$", text, re.I) or re.fullmatch(r"[0-9a-f]{32,64}", text, re.I):
        return False
    if re.match(r"^(?:arxiv\s*:\s*|\d{4}\.\d{4,5}(?:v\d+)?\b|doi\s*:|10\.\d{4,9}/|https?://|www\.)", text, re.I):
        return False
    return not re.match(
        r"^(?:\d+[.\s]+(?:introduction|background)\b|copyright\b|©|all rights reserved\b|"
        r"provided proper attribution\b|preprint\b|submitted to\b|under review\b|"
        r"published as\b|accepted (?:at|by|for|as)\b|proceedings of\b|journal of\b|"
        r"anonymous (?:author|submission)|microsoft word\b|latex template\b)", text, re.I)


def _weighted_size(spans):
    sizes = sorted((s["size"], len(s["text"].strip())) for s in spans if s["text"].strip())
    halfway, total = sum(weight for _, weight in sizes) / 2, 0
    for size, weight in sizes:
        total += weight
        if total >= halfway:
            return size
    return 0


def _page_title(doc):
    if not len(doc):
        return ""
    page = doc[0]
    # Text coordinates are unrotated, even when the PDF page has /Rotate set.
    width, height = page.cropbox.width, page.cropbox.height
    rows = []
    for block in page.get_text("dict", flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)["blocks"]:
        for line in block.get("lines", []):
            dx, dy = line.get("dir", (1, 0))
            if dx < .98 or abs(dy) > .1:
                continue  # arXiv side stamps can be larger than the actual title.
            spans = [s for s in line.get("spans", []) if s["text"].strip()
                     and not re.fullmatch(r"[∗*†‡⋆]+", s["text"].strip())]
            if not spans:
                continue
            parts, previous = [], None
            for span in spans:
                if (previous and not previous["text"].endswith(" ") and not span["text"].startswith(" ")
                        and span["bbox"][0] - previous["bbox"][2] > min(span["size"], previous["size"]) * .15):
                    parts.append(" ")
                parts.append(span["text"])
                previous = span
            text = _clean_title("".join(parts))
            if re.fullmatch(r"\d{1,4}", text):
                continue  # Margin line numbers must not split a multi-line title.
            rows.append({"text": text, "size": _weighted_size(spans),
                         "bbox": line["bbox"], "baseline": max(s["origin"][1] for s in spans)})
    rows.sort(key=lambda r: (r["bbox"][1], r["bbox"][0]))
    boundary = min([height * .5] + [r["bbox"][1] for r in rows if re.fullmatch(
        r"(?:abstract|摘要|(?:1[.\s]*)?(?:introduction|引言))\s*[:：]?", r["text"], re.I)])
    body = [{"size": r["size"], "text": r["text"]} for r in rows
            if r["bbox"][1] >= boundary and len(r["text"]) >= 40]
    minimum_size = max(11, _weighted_size(body) * 1.1)
    groups, group = [], []
    for row in rows:
        x0, y0, x1, y1 = row["bbox"]
        eligible = (height * .02 <= y0 < boundary and x1 > width * .08 and x0 < width * .92
                    and row["size"] >= minimum_size and _usable_title(row["text"]))
        if not eligible:
            group = []
            continue
        adjacent = False
        if group:
            previous = group[-1]
            px0, py0, px1, py1 = previous["bbox"]
            size = max(r["size"] for r in group + [row])
            aligned = abs(x0 - px0) <= width * .035 or abs((x0 + x1) - (px0 + px1)) <= width * .12
            adjacent = (min(r["size"] for r in group + [row]) >= size * .9 and aligned
                        and size * .6 <= row["baseline"] - previous["baseline"] <= size * 1.8
                        and y0 - py1 <= size * .7 and len(group) < 6)
        if not adjacent:
            group = []
            groups.append(group)
        group.append(row)
    candidates = [(_weighted_size(g), -g[0]["bbox"][1], _clean_title("\n".join(r["text"] for r in g)))
                  for g in groups]
    candidates = [c for c in candidates if _usable_title(c[2])]
    return max(candidates)[2] if candidates else ""


def paper_title(doc, file_name, *, previous_title=""):
    """Use real metadata/page headings; filenames are only a last resort."""
    metadata = _clean_title((doc.metadata or {}).get("title"))
    heading = _page_title(doc)
    filename = _clean_title(Path(file_name).stem)[:600]
    if _usable_title(metadata):
        # Some exporters put the download name or only the first title line in /Title.
        prefix = metadata.casefold().rstrip(".:… ")
        if heading and (metadata.casefold() == filename.casefold()
                        or (heading.casefold().startswith(prefix) and len(heading) > len(metadata))):
            return heading
        return metadata
    if heading:
        return heading
    # Do not downgrade a previously known title if a PDF has no usable text layer.
    if _usable_title(previous_title):
        return previous_title
    return filename or "未命名论文"


def paper_work_id(doc, title):
    """Group editions only with matching titles AND complete, matching abstracts.

    PDF hashes remain the identity for reading positions, annotations and caches:
    anonymous and camera-ready editions may have different page geometry.
    Insufficient evidence intentionally leaves papers separate.
    """
    if not len(doc):
        return None
    text = unicodedata.normalize("NFKC", doc[0].get_text()).replace("\u00ad", "")
    # Submission line numbers are separate lines, not abstract prose.
    text = re.sub(r"(?m)^\s*\d{1,4}\s*$", "", text)
    start = re.search(r"(?im)^\s*(?:abstract|摘要)\s*\n", text)
    if not start:
        return None
    tail = text[start.end():]
    end = re.search(r"(?im)^\s*(?:1[.\s]*)?(?:introduction|引言|引论|绪论)\s*(?:\n|$)", tail)
    if not end:
        return None  # Do not fingerprint a truncated abstract or the whole body.
    abstract = tail[:end.start()]
    abstract = re.sub(r"(?<=[A-Za-z])-\s*\n\s*(?=[a-z])", "", abstract)
    abstract = re.sub(r"\s+", " ", abstract).strip().casefold()
    normalized_title = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", title)).strip().casefold()
    if not normalized_title or not 200 <= len(abstract) <= 8000 or sum(c.isalpha() for c in abstract) < 120:
        return None
    return hashlib.sha256((normalized_title + "\n" + abstract).encode("utf-8")).hexdigest()


def _identity_fields(doc, title, source):
    return {"work_id": paper_work_id(doc, title), "identity_version": 1, "title_version": TITLE_VERSION,
            "identity_source": [source.st_size, source.st_mtime_ns]}


def reading_state(value):
    """Whitelist finite values so malformed clients cannot poison future restores."""
    if not isinstance(value, dict):
        raise ValueError("阅读状态格式错误")
    mode = value.get("mode", "continuous")
    if mode not in ("continuous", "single", "duo"):
        raise ValueError("阅读模式无效")
    def number(key, default, lo, hi):
        n = value.get(key, default)
        if isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) or not lo <= n <= hi:
            raise ValueError("阅读状态数值无效: " + key)
        return n
    result = {"mode": mode, "page": int(number("page", 1, 1, 100000)),
              "scale": number("scale", 1, .25, 4),
              "duoScale": number("duoScale", 1, .25, 4),
              "duoOriginalScale": number("duoOriginalScale", 1, .25, 4)}
    for key in ("fitWidth", "duoFitOriginal", "duoFitTranslation", "duoShowOriginal"):
        result[key] = value.get(key, True) is not False
    for key in ("continuous", "single", "original", "translation"):
        anchor = value.get(key)
        if isinstance(anchor, dict):
            nums = {k: anchor.get(k, 0) for k in ("x", "y")}
            if all(isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n) and -1 <= n <= 100 for n in nums.values()):
                result[key] = nums
                if key == "continuous":
                    result[key]["page"] = max(1, min(100000, int(anchor.get("page", result["page"])) ))
    if "legacyScrollTop" in value:
        result["legacyScrollTop"] = number("legacyScrollTop", 0, 0, 100000000)
    return result


class PaperLibrary:
    def __init__(self, directory, uploads):
        self.directory = Path(directory)
        self.uploads = Path(uploads)
        self.lock = threading.RLock()

    def _path(self, digest):
        if not valid_hash(digest):
            raise ValueError("无效的论文标识")
        return self.directory / (digest + ".json")

    def get(self, digest):
        path = self._path(digest)
        if not path.exists():
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
        if (not isinstance(value, dict) or value.get("hash") != digest
                or not all(isinstance(value.get(k), str) for k in ("title", "file_name"))
                or not all(isinstance(value.get(k), (int, float)) and math.isfinite(value[k]) and value[k] >= 0
                           for k in ("page_count", "imported_at", "last_read", "updated_at"))):
            raise ValueError("论文记录损坏，请保留数据目录并恢复备份")
        if value.get("reading") is not None:
            reading_state(value["reading"])
        return value

    def _write(self, record):
        path = self._path(record["hash"])
        self.directory.mkdir(parents=True, exist_ok=True)
        temp = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.directory, suffix=".tmp", delete=False) as stream:
                temp = stream.name
                json.dump(record, stream, ensure_ascii=False, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, path)
        finally:
            if temp and os.path.exists(temp):
                os.unlink(temp)

    def _with_identity(self, record):
        """Refresh titles and edition identity once, without changing reading history."""
        pdf = self.uploads / (record["hash"] + ".pdf")
        try:
            source = pdf.stat()
            if (record.get("identity_version") == 1
                    and record.get("title_version") == TITLE_VERSION
                    and record.get("identity_source") == [source.st_size, source.st_mtime_ns]
                    and (record.get("work_id") is None or valid_hash(record.get("work_id")))):
                return record
            with fitz.open(pdf) as doc:
                title = paper_title(doc, record["file_name"], previous_title=record["title"])
                result = {**record, "title": title, **_identity_fields(doc, title, source)}
        except (RuntimeError, ValueError, OSError):
            return record  # Missing/damaged PDFs must not hide their saved history.
        try:
            self._write(result)
        except OSError:
            # Identification is also usable in-memory if the directory is read-only.
            # Actual reading-state write failures still surface through save().
            pass
        return result

    def register(self, digest, file_name="document.pdf"):
        with self.lock:
            record = self.get(digest)
            pdf = self.uploads / (digest + ".pdf")
            if record and (record["page_count"] or not pdf.exists()):
                return self._with_identity(record)
            title, page_count = Path(file_name).stem, 0
            identity = {}
            if pdf.exists():
                try:
                    source = pdf.stat()
                    with fitz.open(pdf) as doc:
                        title, page_count = paper_title(doc, file_name), len(doc)
                        identity = _identity_fields(doc, title, source)
                except (RuntimeError, ValueError, OSError):
                    pass  # Keep the library entry even if the saved PDF needs reimporting.
            if record:
                record.update(title=title, page_count=page_count, **identity)
                self._write(record)
                return record
            record = {"hash": digest, "title": title or "未命名论文", "file_name": file_name,
                      "page_count": page_count, "imported_at": int(time.time() * 1000),
                      "last_read": 0, "updated_at": 0, "reading": None, **identity}
            self._write(record)
            return record

    def list(self):
        items, damaged = [], 0
        with self.lock:
            for path in self.directory.glob("*.json"):
                try:
                    record = self._with_identity(self.get(path.stem))
                    record["available"] = (self.uploads / (path.stem + ".pdf")).exists()
                    items.append(record)
                except (ValueError, OSError):
                    damaged += 1
        items.sort(key=lambda r: (bool(r["last_read"]), r["last_read"], r["imported_at"]), reverse=True)
        return {"items": items, "damaged": damaged}

    def save(self, digest, reading, updated_at, last_read):
        reading = reading_state(reading)
        now = int(time.time() * 1000)
        if not all(isinstance(n, (int, float)) and math.isfinite(n) and 0 <= n <= now + 60000 for n in (updated_at, last_read)):
            raise ValueError("阅读时间无效")
        with self.lock:
            record = self.get(digest)
            if record is None:
                # Retry after an import's metadata write failed (e.g. temporarily read-only disk).
                if not (self.uploads / (digest + ".pdf")).exists():
                    raise ValueError("论文尚未加入论文库，请重新打开")
                meta_path = self.uploads / (digest + ".meta.json")
                meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
                record = self.register(digest, meta.get("file_name") or "document.pdf")
            if updated_at > record["updated_at"]:
                if record["page_count"]:
                    reading["page"] = min(reading["page"], record["page_count"])
                record.update(reading=reading, updated_at=updated_at, last_read=max(record["last_read"], last_read))
                self._write(record)
            return record

    def migrate(self, entries):
        with self.lock:
            for entry in entries:
                digest = entry.get("hash")
                if not valid_hash(digest):
                    continue
                # Idempotent: existing disk records always win over legacy browser data.
                if self.get(digest):
                    continue
                file_name = entry.get("name") or "document.pdf"
                meta = self.uploads / (digest + ".meta.json")
                if meta.exists():
                    try:
                        file_name = json.loads(meta.read_text(encoding="utf-8")).get("file_name") or file_name
                    except (ValueError, OSError):
                        pass
                record = self.register(digest, str(file_name)[:600])
                progress = entry.get("progress") or {}
                try:
                    legacy = reading_state({"page": progress.get("page", 1), "legacyScrollTop": progress.get("scrollTop", 0)})
                    stamp = max(float(entry.get("time", 0)), float(progress.get("time", 0)))
                    stamp = max(0, min(int(time.time() * 1000), stamp)) if math.isfinite(stamp) else 0
                except (ValueError, TypeError, OverflowError):
                    legacy, stamp = reading_state({}), 0
                record.update(last_read=stamp, reading=legacy)
                self._write(record)
        return self.list()
