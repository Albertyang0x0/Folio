"""导出译文 PDF：擦除原文字块区域（按局部背景色填充），原位插入中文译文。

字体策略：
- 优先使用系统微软雅黑（msyh.ttc，覆盖中文/拉丁/希腊/常见数学符号），单一字体、无宽度错乱；
- 找不到雅黑时回退到 china-s(中文) + helv/hebo(拉丁) 分字体方案。
- 公式块（math=True）不擦除、不重写，保持原样。
"""
import re

import fitz

ZH_FONT = fitz.Font("china-s")
LT_FONT = fitz.Font("helv")
LT_BOLD_FONT = fitz.Font("hebo")
LINE_HEIGHT = 1.4

_MSYH_PATH = "C:/Windows/Fonts/msyh.ttc"
_MSYHBD_PATH = "C:/Windows/Fonts/msyhbd.ttc"
MSYH = None
MSYHBD = None
try:
    MSYH = fitz.Font(fontfile=_MSYH_PATH)
except Exception:
    MSYH = None
try:
    MSYHBD = fitz.Font(fontfile=_MSYHBD_PATH)
except Exception:
    MSYHBD = None

_CJK = re.compile(r"[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]")


def _font_for_width(cls, bold):
    if MSYH:
        return MSYHBD if (bold and MSYHBD) else MSYH
    return ZH_FONT if cls == "zh" else (LT_BOLD_FONT if bold else LT_FONT)


def _font_name(cls, bold):
    if MSYH:
        return "Fb" if (bold and MSYHBD) else "F0"
    return "china-s" if cls == "zh" else ("hebo" if bold else "helv")


def build_translated_pdf(doc, items):
    """items: [{page: int(0 基), blocks: [{bbox, text, font_size, color, bold, math}]}]"""
    by_page = {}
    for it in items:
        by_page.setdefault(int(it["page"]), []).extend(it.get("blocks") or [])
    for pno in range(len(doc)):
        blocks = by_page.get(pno)
        if not blocks:
            continue
        page = doc[pno]
        pix = None

        def bg_color(rect):
            nonlocal pix
            if pix is None:
                pix = page.get_pixmap(matrix=fitz.Matrix(1, 1), colorspace=fitz.csRGB)
            return _sample_bg(pix, rect, page.rect)

        # 先整体擦除（pix 在 apply_redactions 之前渲染，采样的是原始背景色）
        for b in blocks:
            if not (b.get("text") or "").strip():
                continue
            if b.get("math") or b.get("skip"):
                continue  # 公式/表格/算法保持原样
            rect = fitz.Rect(b["bbox"])
            w, h = rect.width, rect.height
            if h > 4 * w and h > 60:
                continue  # 竖排块（水印等）保持原样
            rect = fitz.Rect(rect.x0 - 1.5, rect.y0 - 1.5, rect.x1 + 1.5, rect.y1 + 1.5)
            page.add_redact_annot(rect, fill=bg_color(rect))
        page.apply_redactions()

        # 注册字体（apply_redactions 会重置字体资源，必须在其之后注册）
        if MSYH:
            page.insert_font(fontname="F0", fontfile=_MSYH_PATH)
            if MSYHBD:
                page.insert_font(fontname="Fb", fontfile=_MSYHBD_PATH)

        # 再原位插入译文（正文统一用页面中位字号，避免大小不一）
        body_fs = _page_body_fs(blocks)
        for b in blocks:
            text = (b.get("text") or "").strip()
            if not text:
                continue
            if b.get("math") or b.get("skip"):
                continue
            rect = fitz.Rect(b["bbox"])
            w, h = rect.width, rect.height
            if h > 4 * w and h > 60:
                continue
            if not (float(b.get("font_size") or 10) > body_fs * 1.08):
                b = dict(b)
                b["font_size"] = body_fs
            _insert_translated(page, rect, text, b)
    return doc


def _page_body_fs(blocks):
    """页面正文字号：取非跳过/非公式块字号（8~20pt）的中位数。"""
    sizes = sorted(float(b.get("font_size") or 10) for b in blocks
                   if not b.get("skip") and not b.get("math") and 8 <= (b.get("font_size") or 10) < 20)
    return sizes[len(sizes) // 2] if sizes else 10.0


def _sample_bg(pix, rect, page_rect):
    """在块四周采样像素，取中位数作为局部背景色。"""
    x0 = max(rect.x0, 0)
    y0 = max(rect.y0, 0)
    x1 = min(rect.x1, page_rect.x1)
    y1 = min(rect.y1, page_rect.y1)
    w = max(x1 - x0, 1)
    h = max(y1 - y0, 1)
    pts = []
    for i in range(6):
        t = i / 5.0
        x = x0 + w * t
        y = y0 + h * t
        pts += [
            (x, max(y0 - 2, 0)),
            (x, min(y1 + 2, page_rect.y1 - 1)),
            (max(x0 - 2, 0), y),
            (min(x1 + 2, page_rect.x1 - 1), y),
        ]
    cols = []
    for px, py in pts:
        try:
            cols.append(pix.pixel(int(px), int(py)))
        except Exception:
            pass
    if not cols:
        return (1.0, 1.0, 1.0)
    return tuple(sorted(c[i] for c in cols)[len(cols) // 2] / 255.0 for i in range(3))


def _pieces(text):
    """把文本切成 (类别, 片段)：zh=连续汉字，lt=连续拉丁/数字/符号。"""
    pieces = []
    cur = ""
    for ch in text:
        if _CJK.match(ch):
            if cur:
                pieces.append(("lt", cur))
                cur = ""
            pieces.append(("zh", ch))
        else:
            cur += ch
    if cur:
        pieces.append(("lt", cur))
    return pieces


def _seg_width(cls, s, fs, bold):
    return _font_for_width(cls, bold).text_length(s, fontsize=fs)


def _line_width(line, fs, bold):
    return sum(_seg_width(cls, s, fs, bold) for cls, s in line)


def _wrap(text, max_w, fs, bold, first_indent=0.0):
    """返回行列表；每行是 [(cls, 文本), ...] 分段列表。首行可按 first_indent 缩进。"""
    lines, cur, cur_w = [], [], 0.0
    limit = max_w - first_indent
    for cls, s in _pieces(text):
        if cls == "zh":
            w = _seg_width("zh", s, fs, bold)
            if cur and cur_w + w > limit:
                lines.append(cur)
                cur, cur_w = [], 0.0
                limit = max_w
            cur.append(("zh", s))
            cur_w += w
            continue
        # 拉丁/符号段：按单词切分换行
        for word in re.split(r"(\s+)", s):
            if not word:
                continue
            w = _seg_width("lt", word, fs, bold)
            if word.isspace():
                if cur:
                    cur.append(("lt", word))
                    cur_w += w
                continue
            if cur and cur_w > 0 and cur_w + w > limit:
                lines.append(cur)
                cur, cur_w = [], 0.0
                limit = max_w
            cur.append(("lt", word))
            cur_w += w
    if cur:
        lines.append(cur)
    out = []
    for line in lines:
        while line and line[-1][0] == "lt" and line[-1][1].isspace():
            line.pop()
        if line:
            out.append(line)
    return out


def _insert_translated(page, rect, text, meta):
    orig_size = float(meta.get("font_size") or 10)
    bold = bool(meta.get("bold"))
    color_int = int(meta.get("color") or 0)
    color = (
        ((color_int >> 16) & 255) / 255.0,
        ((color_int >> 8) & 255) / 255.0,
        (color_int & 255) / 255.0,
    )
    centered = abs((rect.x0 + rect.x1) / 2.0 - page.rect.width / 2.0) < 3
    # 字号尽量用原始/统一字号，最多缩到 0.9 倍（保持大小统一），允许高度到 1.35 倍
    lo, hi = max(orig_size * 0.9, 4.0), max(orig_size, 6.0)
    best = None
    for _ in range(16):
        fs = (lo + hi) / 2.0
        lines = _wrap(text, rect.width, fs, bold)
        ok = (
            len(lines) * fs * LINE_HEIGHT <= rect.height * 1.35
            and max(_line_width(ln, fs, bold) for ln in lines) <= rect.width * 1.02
        )
        if ok:
            best = (fs, lines)
            lo = fs
        else:
            hi = fs
    fs, lines = best if best else (lo, _wrap(text, rect.width, lo, bold))
    # 中文段落首行缩进 2 字符（多行且非居中）
    indent = 0.0
    if not centered and len(lines) > 1:
        indent = fs * 2.0
        lines = _wrap(text, rect.width, fs, bold, first_indent=indent)
    y = rect.y0
    for idx, ln in enumerate(lines):
        if MSYH:
            asc = MSYH.ascender
        else:
            has_zh = any(cls == "zh" for cls, _ in ln)
            asc = ZH_FONT.ascender if has_zh else LT_FONT.ascender
        baseline = y + asc * fs
        lw = _line_width(ln, fs, bold)
        x = rect.x0 + (rect.width - lw) / 2.0 if centered else rect.x0
        if idx == 0 and indent:
            x += indent
        for cls, seg in ln:
            page.insert_text((x, baseline), seg, fontsize=fs, fontname=_font_name(cls, bold), color=color)
            x += _seg_width(cls, seg, fs, bold)
        y += fs * LINE_HEIGHT
