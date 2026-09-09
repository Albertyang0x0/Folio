"""PDF 文本块提取：段落级块 + 坐标 + 字体信息（供翻译与重绘使用）。"""
import re
from collections import Counter

import fitz

# 纯符号/数字（页码、纯公式符号行等）——不送翻译
SKIP_RE = re.compile(
    r"^[\s\d\-\u2013\u2014\u00b7\u00b0.,;:()\[\]{}<>+=*/|_~^%&$#@!?'\"\\]+$"
)

# 数学符号（用于识别公式行）
MATH_CHARS = set("∑∫∏∂√∇∞∈∉⊂⊆∀∃≤≥≠±×÷⋅→←↔⇒⇔∪∩∅⊗⊕⊥∥⋯…≈≡∝≪≫−∼⟨⟩"
                "αβγδεζηθικλμνξοπρστυφχψωΓΔΘΛΞΠΣΦΨΩ⋆∗∴∵∘∙†‡")
# 常见数学字体名（LaTeX/Word 数学模式专用字体）
MATH_FONTS = ("cmmi", "cmsy", "cmex", "msam", "msbm", "mtmi", "mtsyn",
              "latinmodernmath", "xits", "stix", "cambria math", "cambriamath", "mathjax")
LATEX_RE = re.compile(r"\\[a-zA-Z]+")
BRACE_MATH_RE = re.compile(r"[_^=←→±≤≥∈∑∫∂√]")
EQUATION_RE = re.compile(r"=|→|^\s*(arg|max|min)\b|\^|_")
ALGO_START_RE = re.compile(r"^\s*(Algorithm|Alg\.)\s*\d+", re.I)
# 表格标题：要求 "Table N" 后跟冒号/句点/破折号，避免匹配 "Table 2 summarizes..." 这类正文句
TABLE_CAPTION_RE = re.compile(r"^\s*(Table|Tab\.)\s*\d+\s*[:.\u00b7\u2013\u2014]", re.I)
# 有些模板在编号后不加冒号或句点。这个宽松形式只能与真实横线/数值网格
# 联合使用，不能单独作为表格依据，否则 "Table 2 summarizes..." 会误报。
TABLE_START_RE = re.compile(r"^\s*(Table|Tab\.)\s*\d+\b", re.I)
# 图注：要求 "Figure N" 后跟冒号/句点/破折号
FIG_CAPTION_RE = re.compile(r"^\s*(Figure|Fig\.)\s*\d+\s*[:.\u00b7\u2013\u2014]", re.I)
# 参考文献：引文编号 [1] / [1,2] / [1-3] 起始
CITE_RE = re.compile(r"^\[[\d,\s\-\u2013]+\]")
REF_HEAD_RE = re.compile(r"^\s*References?\s*$", re.I)
REF_MARK_RE = re.compile(r"\b(?:arXiv|CoRR|doi:|ISBN)\b", re.I)


def _is_function_definition(text, font):
    return bool("cmr" in (font or "").lower() and re.match(
        r"^(?:where\s+)?[A-Za-z][A-Za-z0-9]*(?:_\{?\w+\}?)?(?:\([^)]*\))?\s*=\s*[A-Za-z][A-Za-z0-9]*\s*\(", text))


def _is_math_line(text, font):
    """判断一行是否为数学公式（公式不翻译、不擦除，保持原样）。"""
    syms = sum(1 for c in text if c in MATH_CHARS)
    alnum = sum(1 for c in text if c.isalnum())
    words = re.findall(r"[A-Za-z][A-Za-z'\-]{1,}", text)
    # Roman TeX fonts also spell operator names (MultiHead, Concat, Attention).
    # A function definition is not prose merely because it contains four words.
    if _is_function_definition(text, font):
        return True
    # Explanatory clauses around display equations are prose even when most of
    # their remaining glyphs use math fonts (common in physics papers).
    if (re.search(r"\b(?:where|with)\b", text, re.I)
            and not re.search(r"\(\d+\)\s*$", text)):
        return False
    # 含少量内联数学符号的自然语言仍是正文。旧逻辑会把含 →、τ、Pass@1
    # 的完整句子整块判为公式，导致后端不翻译、前端又把原文裁回来。
    if len(words) >= 4 and sum(len(w) for w in words) >= max(12, syms * 3):
        return False
    # 含 LaTeX 命令且空格很少 → 公式
    if LATEX_RE.search(text) and text.count(" ") <= 2:
        return True
    # LaTeX 花括号（下标/上标/集合记号，如 {Il}L−1、←Shuffle{Dl}l=0）→ 公式；
    # 但若是长句正文（含多个英文单词），不判为公式，避免 "dataset D = {x1,...} to derive" 这类正文句被保留
    if "{" in text and "}" in text and BRACE_MATH_RE.search(text):
        if len(text) < 40 or (syms >= max(2, alnum * 0.4)):
            return True
    if syms >= 2 and syms >= alnum * 0.5:
        return True
    fl = (font or "").lower()
    if any(k in fl for k in MATH_FONTS):
        return True
    # 短块：仅当符号密集（字母很少）或带公式算子且字母不多时才视为公式，
    # 避免把含内联符号（如 "K −1"、"ρ"）的正文句误判为公式而不翻译
    if len(text) < 70 and syms >= 1 and alnum <= 2 * syms:
        return True
    if len(text) < 50 and EQUATION_RE.search(text) and alnum <= 12:
        return True
    if len(text) < 70 and ("cmr" in fl or "times" in fl) and EQUATION_RE.search(text):
        return True
    return False


def _mark_references(blocks):
    """标记参考文献为 skip（不翻译、不擦除，保持原样）。

    识别：References 标题、以 [N] 引文编号起始的条目、含 arXiv/CoRR/doi 的续行，
    以及紧跟引文条目后的缩进续行。
    """
    n = len(blocks)
    for i, b in enumerate(blocks):
        if b.get("math") or b.get("skip"):
            continue
        is_ref = bool(CITE_RE.match(b["text"]) or REF_HEAD_RE.match(b["text"])
                      or (len(b["text"]) < 60 and REF_MARK_RE.search(b["text"])))
        if not is_ref:
            continue
        b["skip"] = True
        x0 = b["bbox"][0]
        prev_y1 = b["bbox"][3]
        for j in range(i + 1, n):
            nb = blocks[j]
            if nb.get("math") or nb.get("skip"):
                continue
            # 缩进续行（同一引文条目换行）
            if nb["bbox"][0] > x0 + 3 and (nb["bbox"][1] - prev_y1) < 14:
                nb["skip"] = True
                prev_y1 = nb["bbox"][3]
                continue
            break


def _mark_region_below(lines, i, max_chars, page_width):
    """从标题行 i 向下标记密集短行（表格单元格/伪代码），遇到边界停止。

    第一段（标题到表格/算法体）允许较大间距；后续行要求间距 <15pt 且文本短。
    遇到整栏宽度的正文行、加粗大标题或大间距即停止。
    """
    n = len(lines)
    cap_size = lines[i]["font_size"]
    prev_y1 = lines[i]["bbox"][3]
    first = True
    max_w = page_width * 0.6
    for j in range(i + 1, n):
        nb = lines[j]
        if nb.get("skip") or nb.get("math"):
            prev_y1 = max(prev_y1, nb["bbox"][3])
            continue
        gap = nb["bbox"][1] - prev_y1
        max_gap = 40 if first else 15
        if gap > max_gap:
            break
        # 加粗且字号更大的标题 → 结束（表头行除外）
        if not first and nb["bold"] and nb["font_size"] >= cap_size + 0.5:
            break
        # 整栏宽度的正文行 → 结束（表格单元格窄、正文行几乎占满整栏）
        w = nb["bbox"][2] - nb["bbox"][0]
        if not first and w > max_w and len(nb["text"]) > 25:
            break
        if len(nb["text"]) < (100 if first else max_chars):
            nb["skip"] = True
            prev_y1 = max(prev_y1, nb["bbox"][3])
            first = False
            continue
        break


def _cluster_1d(vals, tol):
    vals = sorted(vals)
    groups = []
    for v in vals:
        if groups and v - groups[-1][-1] <= tol:
            groups[-1].append(v)
        else:
            groups.append([v])
    return groups


def _detect_table_cells(lines, page_width):
    """结构化的表格网格检测：把按行列对齐的小单元格识别为表格，返回应 skip 的行下标。"""
    max_w = page_width * 0.6
    cell = [k for k, ln in enumerate(lines)
            if not (ln.get("skip") or ln.get("math"))
            and (ln["bbox"][3] - ln["bbox"][1]) < 30
            and (ln["bbox"][2] - ln["bbox"][0]) < max_w
            and len(ln["text"]) < 40]
    if len(cell) < 6:
        return set()
    colg = _cluster_1d([lines[k]["bbox"][0] for k in cell], 5)
    rowg = _cluster_1d([lines[k]["bbox"][1] for k in cell], 5)
    col_of = {v: i for i, g in enumerate(colg) for v in g}
    row_of = {v: i for i, g in enumerate(rowg) for v in g}
    m = len(cell)
    parent = list(range(m))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    by_row, by_col = {}, {}
    for i, k in enumerate(cell):
        by_row.setdefault(row_of[lines[k]["bbox"][1]], []).append(i)
        by_col.setdefault(col_of[lines[k]["bbox"][0]], []).append(i)
    # 只连接空间上真正相邻的单元格。旧实现会把整页所有相同 x/y 的短行
    # 连成一个巨型网格，两栏正文末尾的短续行因此会被误标为表格。
    # 两栏论文正文的栏间距通常远大于真正表格的单元格间距。
    max_row_gap = page_width * 0.24
    for ids in by_row.values():
        ids.sort(key=lambda i: lines[cell[i]]["bbox"][0])
        for a, b in zip(ids, ids[1:]):
            la, lb = lines[cell[a]], lines[cell[b]]
            if lb["bbox"][0] - la["bbox"][2] <= max_row_gap:
                union(a, b)
    for ids in by_col.values():
        ids.sort(key=lambda i: lines[cell[i]]["bbox"][1])
        for a, b in zip(ids, ids[1:]):
            la, lb = lines[cell[a]], lines[cell[b]]
            if lb["bbox"][1] - la["bbox"][3] <= 30:
                union(a, b)
    comps = {}
    for i in range(m):
        comps.setdefault(find(i), []).append(i)
    marked = set()
    for ids in comps.values():
        if len(ids) < 6:
            continue
        ncols = len(set(col_of[lines[cell[i]]["bbox"][0]] for i in ids))
        nrows = len(set(row_of[lines[cell[i]]["bbox"][1]] for i in ids))
        if not (2 <= ncols <= 16 and nrows >= 3):
            continue
        if len(ids) < 0.5 * ncols * nrows:
            continue
        row_ys = sorted(set(lines[cell[i]]["bbox"][1] for i in ids))
        gaps = [b - a for a, b in zip(row_ys, row_ys[1:])]
        if gaps and sorted(gaps)[len(gaps) // 2] > 30:
            continue
        for i in ids:
            marked.add(cell[i])
    return marked


def _mark_float_lines(lines, page_width):
    """标记「表格」与「算法」行为 skip=True（不翻译、不擦除，保持原样）。

    以 Table N: / Algorithm N 标题行为锚点，向下标记紧邻的密集短行；
    再用结构化的网格检测补上表格单元格（含标题在表格下方的情形）。
    """
    for i, ln in enumerate(lines):
        if ALGO_START_RE.match(ln["text"]):
            ln["skip"] = True
            _mark_region_below(lines, i, 80, page_width)
        elif TABLE_CAPTION_RE.match(ln["text"]):
            ln["skip"] = True
            _mark_region_below(lines, i, 40, page_width)
        elif FIG_CAPTION_RE.match(ln["text"]):
            # 图注常跨多行；只沿紧邻、同字号、同起始位置的行继续，遇到正文间距即停。
            ln["skip"] = True
            prev_y1 = ln["bbox"][3]
            for j in range(i + 1, len(lines)):
                nb = lines[j]
                gap = nb["bbox"][1] - prev_y1
                if gap > max(5.0, ln["font_size"] * 0.65):
                    break
                if abs(nb["font_size"] - ln["font_size"]) > 0.6:
                    break
                if abs(nb["bbox"][0] - ln["bbox"][0]) > max(12.0, ln["font_size"] * 1.25):
                    break
                nb["skip"] = True
                prev_y1 = max(prev_y1, nb["bbox"][3])
    for k in _detect_table_cells(lines, page_width):
        lines[k]["skip"] = True


def _unmark_body_paragraphs(blocks, page_width):
    """兜底：把被误标为 skip/math 的「正文段落」恢复正常翻译。

    某些正文段（如 "Implementation (Alg. 1)..."、"dataset D = {...} to derive..."）
    因靠近表格/图或含内联符号而被误保留。这里用「长文本 + 多个英文单词 + 非算法标签行」
    识别正文段并取消保留；算法伪代码（Input/Output/Algorithm 等标签）、窄单元格、
    图注/表注仍保留。
    """
    _label = re.compile(r"^\s*(Input|Output|Desc\.|Algorithm|Alg\.|while|for|if\s|return)", re.I)
    for b in blocks:
        if not (b.get("skip") or b.get("math")):
            continue
        if b.get("rotated"):
            continue  # 旋转图表标签仍随原图保留，不能被正文兜底重新放回翻译队列。
        if b.get("_whole_math") or b.get("_table_region") or b.get("_algorithm_region"):
            continue
        t = b.get("text", "")
        if _is_function_definition(t, b.get("font")):
            continue  # Operator names are not prose words, even in long definitions.
        if len(t) < 40:
            continue  # 短块（单元格/公式/图注）保留
        if (FIG_CAPTION_RE.match(t) or TABLE_CAPTION_RE.match(t)
                or ALGO_START_RE.match(t)):
            continue
        if _label.match(t):
            continue  # 算法伪代码标签行保留
        words = len(re.findall(r"[A-Za-z][A-Za-z'\-]+", t))
        if words >= 5 and t.count(" ") >= 4:
            b["skip"] = False
            b["math"] = False


def extract_pages(doc):
    """返回每页的元信息与文本块列表（阅读顺序）。"""
    glyph_bounds = {}
    pages = [_extract_page(doc, pno, glyph_bounds) for pno in range(len(doc))]
    _filter_repeated(pages)
    return pages


def _merge_lines(lines):
    """把相邻、同栏、同字号、同粗斜体的正文行合并；引用链接颜色不是段落边界。"""
    blocks = []
    for ln in lines:
        if blocks and _lines_mergeable(blocks[-1], ln):
            prev = blocks[-1]
            # A bold inline lead-in may end mid-word. Joining its continuation
            # must not turn the entire following paragraph into a bold heading.
            prev["bold"] = (int(prev["bold"]) * len(prev["text"]) + int(ln["bold"]) * len(ln["text"])) > (len(prev["text"]) + len(ln["text"])) * .5
            prev["translation_text"] = _join_paragraph_text(
                prev.get("translation_text", prev["text"]),
                ln.get("translation_text", ln["text"]),
            )
            prev["inline_math"] = prev.get("inline_math", []) + ln.get("inline_math", [])
            prev["_source_block"] = ln.get("_source_block")
            # TeX/PDF 常在换行处插入排版连字符。英文单词续行时去掉它，
            # 例如 se- + quential -> sequential；其他情况仍按普通空格连接。
            if (re.search(r"[A-Za-z]{2}-$", prev["text"])
                    and re.match(r"[a-z]", ln["text"].lstrip())):
                prev["text"] = prev["text"][:-1] + ln["text"].lstrip()
            else:
                prev["text"] += " " + ln["text"]
            p, b = prev["bbox"], ln["bbox"]
            prev["bbox"] = [min(p[0], b[0]), min(p[1], b[1]), max(p[2], b[2]), max(p[3], b[3])]
        else:
            blocks.append(dict(ln))
    return blocks


def _join_paragraph_text(a, b):
    if re.search(r"[A-Za-z]{2}-$", a) and re.match(r"[a-z]", b.lstrip()):
        return a[:-1] + b.lstrip()
    return a + " " + b


def _lines_mergeable(a, b):
    if a.get("_table_region") != b.get("_table_region"):
        return False
    if a.get("_algorithm_region") != b.get("_algorithm_region"):
        return False
    if a.get("_whole_math") or b.get("_whole_math"):
        return False  # A reconstructed display equation is an indivisible block.
    if a.get("rotated") or b.get("rotated"):
        return False
    gap = b["bbox"][1] - a["bbox"][3]
    size = min(a["font_size"], b["font_size"])
    # 上下标会让相邻视觉行的 bbox 轻微重叠；只要行中心仍向下推进，
    # 允许最多约半个字号的重叠。
    if gap < 0:
        ac = (a["bbox"][1] + a["bbox"][3]) / 2
        bc = (b["bbox"][1] + b["bbox"][3]) / 2
        if not (bc - ac > size * 0.55 and gap >= -size * 0.55):
            return False
    if gap > max(4.0, size * 0.9):
        return False
    # 允许论文正文约一个 em 的首行缩进，否则同一段会按物理行拆开翻译。
    if abs(b["bbox"][0] - a["bbox"][0]) > max(12.0, size * 1.25):
        return False
    same_source = (a.get("_source_block") is not None and a.get("_source_block") == b.get("_source_block")
                   and not any(x.get("math") or x.get("skip") for x in (a, b)))
    incomplete = same_source and not re.search(r"[.!?]\s*$", a["text"])
    if abs(b["font_size"] - a["font_size"]) > (size * .2 if incomplete else .6):
        return False
    # 样式不一致则不合并，避免「加粗标题」把「正文」带成加粗
    broken_word = same_source and re.search(r"[A-Za-z]{2}-$", a["text"]) and re.match(r"[a-z]", b["text"])
    if (a["bold"] != b["bold"] or a["italic"] != b["italic"]) and not broken_word:
        return False
    if a["color"] != b["color"] and (a.get("math") or a.get("skip") or b.get("math") or b.get("skip")):
        return False
    # 公式行与正文行不合并
    if a.get("math") != b.get("math"):
        return False
    # 表格/算法行与正文行不合并
    if a.get("skip") != b.get("skip"):
        return False
    return True


def _span_baseline(span):
    # A PDF span can start with a synthetic space whose origin still belongs to
    # the preceding subscript. Visible characters carry the actual prose baseline.
    ys = sorted(c["origin"][1] for c in span.get("chars", []) if c.get("c", "").strip())
    return ys[len(ys) // 2] if ys else float((span.get("origin") or (0, span["bbox"][3]))[1])


def _raw_line_baseline(line):
    """估算 PyMuPDF 原始行的主基线，用于合并上下标造成的伪行。"""
    spans = [s for s in line.get("spans", []) if s.get("text", "").strip()]
    if not spans:
        return (line["bbox"][1] + line["bbox"][3]) / 2, 10.0
    max_size = max(float(s.get("size") or 10) for s in spans)
    main = [s for s in spans if float(s.get("size") or 10) >= max_size * 0.85]
    ys = [_span_baseline(s) for s in main]
    ys.sort()
    return ys[len(ys) // 2], max_size


def _is_horizontal(line):
    dx, dy = line.get("dir", (1.0, 0.0))
    return dx > 0.999 and abs(dy) < 0.001


def _group_visual_lines(raw_lines):
    """把同一视觉行中被上下标拆开的多个 PyMuPDF line 合并。"""
    groups = []
    for line in raw_lines:
        if not line.get("spans"):
            continue
        baseline, size = _raw_line_baseline(line)
        x0 = float(line["bbox"][0])
        if groups and _is_horizontal(line) and _is_horizontal(groups[-1]["lines"][0]):
            g = groups[-1]
            tol = max(3.5, max(size, g["size"]) * 0.50)
            # A small denominator at the end of a prose row is vertically stacked
            # on its numerator, not a new paragraph. Limit this to overlapping,
            # small math fragments inside the preceding row's horizontal extent.
            small_math = (size < g["size"] * .85 and x0 > g["left"] + g["size"] * .8
                          and line["bbox"][2] <= g["right"] + g["size"]
                          and line["bbox"][1] < g["bottom"] + g["size"] * .25
                          and abs(baseline - g["baseline"]) < g["size"] * 1.5
                          and all(_dedicated_math_span(s) or re.fullmatch(r"[\s\d().,]+", s.get("text", ""))
                                  for s in line["spans"]))
            if ((abs(baseline - g["baseline"]) <= tol or small_math) and x0 >= g["left"] - 2.0):
                g["lines"].append(line)
                g["right"] = max(g["right"], float(line["bbox"][2]))
                g["bottom"] = max(g["bottom"], float(line["bbox"][3]))
                continue
        groups.append({
            "lines": [line], "baseline": baseline, "size": size,
            "left": x0, "right": float(line["bbox"][2]), "bottom": float(line["bbox"][3]),
        })
    return [g["lines"] for g in groups]


def _dedicated_math_span(span):
    font = (span.get("font") or "").lower()
    text = span.get("text", "").strip()
    # STIX/XITS 也有普通正文字体，不能因字体家族名就锁住整句英文。
    dedicated = any(k in font for k in MATH_FONTS if k not in ("stix", "xits"))
    dedicated = dedicated or (("stix" in font or "xits" in font) and "math" in font)
    if len(re.findall(r"[A-Za-z]{3,}", text)) >= 2:
        return False
    return dedicated or (bool(span.get("flags", 0) & 2) and bool(re.fullmatch(r"[A-Za-z]", text)))


def _span_is_math_base(span):
    text = span.get("text", "").strip()
    if len(re.findall(r"[A-Za-z]{3,}", text)) >= 2:
        return False
    return (_dedicated_math_span(span) or bool(re.fullmatch(r"[A-Za-z]", text))
            or any(c in MATH_CHARS for c in text))


def _format_script(kind, value):
    value = re.sub(r"\s+", "", value)
    if not value:
        return ""
    wrapped = value if len(value) == 1 else "{" + value + "}"
    return ("_" if kind == "sub" else "^") + wrapped


def _tight_span_rect(span):
    """忽略 PDF 文本 span 内的空格，避免裁入公式旁边的正文。"""
    chars = [c for c in span.get("chars", []) if c.get("c", "").strip()]
    rect = None
    for char in chars:
        r = fitz.Rect(char["bbox"])
        rect = r if rect is None else rect | r
    return rect if rect is not None else fitz.Rect(span["bbox"])


def _join_visual_pieces(pieces):
    out = ""
    prev_x1 = None
    for piece in pieces:
        x0, x1, text = piece["x0"], piece["x1"], piece["text"]
        if not text:
            continue
        first = text.lstrip()[:1]
        if (out and not out[-1].isspace() and not text[0].isspace()
                and prev_x1 is not None and x0 - prev_x1 > 0.5
                and first not in ",.;:!?)]}-"):
            out += " "
        out += text
        prev_x1 = max(prev_x1 or x1, x1)
    out = re.sub(r"\s+", " ", out).strip()
    out = re.sub(r"\s+([,.;:!?])", r"\1", out)
    return re.sub(r"(?<=[0-9}])\s+-([A-Za-z])", r"-\1", out)


def _formula_pieces(span, text, script_spans, body_size):
    """独立公式字体/上下标为强证据；普通字体只将数学字符划为候选。"""
    math_font = _dedicated_math_span(span)
    rect = _tight_span_rect(span)
    clips = [list(rect)]
    for s in script_spans:
        script_rect = _tight_span_rect(s)
        clips.append(list(script_rect))
        rect |= script_rect
    chars = [c for c in span.get("chars", []) if c.get("c", "").strip()]
    baseline = float((chars[0].get("origin") if chars else span.get("origin", (0, rect.y1)))[1])
    if math_font or script_spans:
        return [{"text": text.strip(), "x0": rect.x0, "x1": rect.x1,
                 "rect": rect, "seed": True, "eligible": True,
                 "baseline": baseline, "clips": clips}]
    # 不能把包含箭头的整句英文当成公式。rawdict 的逐字坐标让我们只裁箭头。
    if not span.get("chars"):
        return [{"text": text, "x0": rect.x0, "x1": rect.x1,
                 "rect": rect, "seed": False, "eligible": False, "baseline": baseline}]
    seeds = (MATH_CHARS - set("…†‡")) | set("=+<>×÷")
    connectors = set("0123456789()[]{}|/−-.*^")
    runs = []
    for char in span["chars"]:
        value = char.get("c", "")
        kind = "space" if value.isspace() else "seed" if value in seeds else "connector" if value in connectors else "text"
        r = fitz.Rect(char["bbox"])
        if runs and runs[-1]["kind"] == kind and kind in ("text", "space"):
            runs[-1]["text"] += value
            runs[-1]["rect"] |= r
            runs[-1]["x1"] = r.x1
        else:
            runs.append({"text": value, "x0": r.x0, "x1": r.x1, "rect": r,
                         "seed": kind == "seed", "eligible": kind in ("seed", "connector", "space"),
                         "kind": kind, "baseline": float(char["origin"][1])})
    return runs


def _build_inline_template(pieces, body_size, math_offset, baseline=None):
    """只保护连续的数学区域，逗号/正文会自然切断区域。"""
    groups, current = [], []
    for piece in pieces:
        if (not piece["eligible"] or (current and piece["x0"] - max(p["x1"] for p in current) > body_size * 0.9)):
            if current:
                groups.append(current)
                current = []
        if piece["eligible"]:
            current.append(piece)
        else:
            groups.append([piece])
    if current:
        groups.append(current)
    output, formulas = [], []
    for group in groups:
        group = list(group)
        prefix, suffix = [], []
        # 句末标点不属于公式；不把横跨英文连接词的一对括号拆成两个不配对公式。
        while group and not group[0]["text"].strip():
            prefix.append(group.pop(0))
        while group and not group[-1]["text"].strip():
            suffix.insert(0, group.pop())
        while group and group[-1]["text"] == ".":
            suffix.insert(0, group.pop())
        for left, right in (("(", ")"), ("[", "]")):
            joined = "".join(p["text"] for p in group)
            if group and joined.count(left) > joined.count(right) and group[0]["text"] == left:
                prefix.append(group.pop(0))
            if group and joined.count(right) > joined.count(left) and group[-1]["text"] == right:
                suffix.insert(0, group.pop())
        members = [p for p in group if p["text"].strip()]
        seeds = [p for p in members if p["seed"]]
        if not seeds:
            output.extend(prefix + group + suffix)
            continue
        # 空格不参与裁框，否则其 nominal bbox 可能延伸到相邻正文行。
        rect = fitz.Rect(members[0]["rect"])
        for piece in members[1:]:
            rect |= piece["rect"]
        raw = _join_visual_pieces(members)
        token = "__MATH_%04d__" % (math_offset + len(formulas))
        formulas.append({"token": token, "text": raw,
                         "bbox": [round(v, 3) for v in rect],
                         "baseline": round(baseline if baseline is not None else seeds[0]["baseline"], 3),
                         "font_size": round(body_size, 3),
                         # 只复制实际公式部件的区域，而不是把整个外接矩形内的
                         # 空白也复制过来（空白角落可能有上一行正文的下伸部）。
                         "clips": [[round(v, 3) for v in clip]
                                   for p in members for clip in p.get("clips", [list(p["rect"])])]})
        output.extend(prefix)
        output.append({"text": " " + token + " ", "x0": rect.x0, "x1": rect.x1})
        output.extend(suffix)
    return _join_visual_pieces(output), formulas


def _merge_formula_continuations(blocks):
    """连接被物理换行拆开的行内等式；普通独立公式/编号公式仍原样保留。"""
    result = []
    for block in blocks:
        previous = result[-1] if result else None
        candidates = block.get("inline_math", [])
        before = previous.get("inline_math", []) if previous else []
        # A complete formula on a wrapped prose line is still inline, e.g.
        # "inner-layer has dimensionality\n d_ff = 2048" or ",\n and W^O ...".
        # PDF paragraph membership, left alignment and close leading distinguish
        # these from a following, independently displayed equation.
        if (previous and not previous.get("math") and not previous.get("skip")
                and block.get("math") and not block.get("skip") and candidates
                and block.get("_source_block") is not None
                and block.get("_source_block") == previous.get("_source_block")
                and not (before and re.search(r"[=+−→]$", before[-1]["text"].rstrip()))
                and not re.search(r"[.!?:;]\s*$", previous["text"])
                and abs(block["bbox"][0] - previous["bbox"][0]) < previous["font_size"] * 1.3
                and -previous["font_size"] < block["bbox"][1] - previous["bbox"][3] < previous["font_size"] * .7):
            remainder = re.sub(r"__MATH_\d{4,}__", "", block.get("translation_text", ""))
            if re.fullmatch(r"[\s,.;]*(?:(?:and|or)[\s,.;]*)?", remainder, re.I):
                previous["text"] = _join_paragraph_text(previous["text"], block["text"])
                previous["translation_text"] = _join_paragraph_text(
                    previous.get("translation_text", ""), block["translation_text"])
                previous["inline_math"] = before + candidates
                previous["bbox"] = list(fitz.Rect(previous["bbox"]) | fitz.Rect(block["bbox"]))
                continue
        can_join = (previous and not previous.get("math") and not previous.get("skip")
                    and block.get("math") and not block.get("skip")
                    and len(candidates) == 1 and before)
        if can_join:
            tail, following = before[-1], candidates[0]
            suffix = block.get("translation_text", "").replace(following["token"], "", 1).strip()
            can_join = (re.search(r"[=+−→]$", tail["text"].rstrip())
                        and previous.get("translation_text", "").rstrip().endswith(tail["token"])
                        and suffix in ("", ".", ",", ";")
                        and abs(block["bbox"][0] - previous["bbox"][0]) < previous["font_size"] * 2
                        and -previous["font_size"] < block["bbox"][1] - previous["bbox"][3] < previous["font_size"] * 1.5)
            if can_join:
                # 每个原始片段单独保存裁框/基线，前端在新行中水平连接，
                # 不能直接裁跨行外接矩形，那样会把旁边的英文整句一起带回来。
                first = {k: v for k, v in tail.items() if k not in ("token", "parts")}
                second = {k: v for k, v in following.items() if k != "token"}
                tail["parts"] = tail.get("parts", [first]) + [second]
                tail["text"] += " " + following["text"]
                previous["text"] = _join_paragraph_text(previous["text"], block["text"])
                previous["translation_text"] += suffix
                previous["bbox"] = list(fitz.Rect(previous["bbox"]) | fitz.Rect(block["bbox"]))
                continue
        result.append(block)
    return result


def _merge_display_math_fragments(blocks, page_width):
    """Join the PDF objects that visually form one display equation.

    TeX does not guarantee that one equation becomes one PDF text block.  A
    fraction, delimiter, equation number, or the two rows of an aligned formula
    may all be emitted separately and in an order unrelated to reading order.
    The old previous-block-only rule therefore worked for simple equations but
    left dense formulas as many independently flowed crops.

    Build local connected components instead.  Connections require the same
    page column plus close/overlapping geometry; two different numbered rows
    are kept separate.  Very short non-math fragments are admitted only when
    they look formula-like, which recovers denominators that were classified by
    their Roman font without swallowing nearby explanatory prose.
    """
    if len(blocks) < 2:
        return blocks

    def formula_candidate(block):
        if block.get("skip"):
            return False
        if block.get("math"):
            return True
        text = (block.get("text") or "").strip()
        size = float(block.get("font_size") or 10)
        rect = fitz.Rect(block["bbox"])
        words = re.findall(r"[A-Za-z]{2,}", text)
        equation_number = bool(re.fullmatch(r"\(\d+\)", text))
        if re.match(r"^(?:where|with)\b", text, re.I):
            return False
        natural_words = [w for w in words if w.lower() not in {
            "sin", "cos", "log", "exp", "max", "min", "relu", "softmax",
        }]
        return equation_number or (len(text) <= 36 and len(natural_words) <= 1
                and rect.height <= size * 3.2
                and (block.get("inline_math") or EQUATION_RE.search(text)
                     or any(ch in MATH_CHARS for ch in text)))

    candidates = [i for i, block in enumerate(blocks) if formula_candidate(block)]
    if len(candidates) < 2:
        return blocks
    parent = {i: i for i in candidates}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i, j):
        a, b = find(i), find(j)
        if a != b:
            parent[b] = a

    def side(rect):
        mid = page_width / 2
        if rect.x1 <= mid + 3:
            return -1
        if rect.x0 >= mid - 3:
            return 1
        return 0

    def gap(a0, a1, b0, b1):
        return max(0.0, max(a0, b0) - min(a1, b1))

    for pos, i in enumerate(candidates):
        a = fitz.Rect(blocks[i]["bbox"])
        a_number = re.findall(r"\((\d+)\)", blocks[i].get("text", ""))
        a_number_only = bool(re.fullmatch(r"\(\d+\)", (blocks[i].get("text") or "").strip()))
        for j in candidates[pos + 1:]:
            b = fitz.Rect(blocks[j]["bbox"])
            sa, sb = side(a), side(b)
            if sa and sb and sa != sb:
                continue
            union_rect = a | b
            width_limit = page_width * (.52 if sa == sb and sa else .88)
            if union_rect.width > width_limit:
                continue
            b_number = re.findall(r"\((\d+)\)", blocks[j].get("text", ""))
            b_number_only = bool(re.fullmatch(r"\(\d+\)", (blocks[j].get("text") or "").strip()))
            if a_number and b_number and a_number[-1] != b_number[-1]:
                continue
            size = max(float(blocks[i].get("font_size") or 10),
                       float(blocks[j].get("font_size") or 10))
            x_gap = gap(a.x0, a.x1, b.x0, b.x1)
            y_gap = gap(a.y0, a.y1, b.y0, b.y1)
            x_overlap = min(a.x1, b.x1) - max(a.x0, b.x0)
            y_overlap = min(a.y1, b.y1) - max(a.y0, b.y0)
            same_row = (y_overlap >= min(a.height, b.height) * .18
                        and x_gap <= max(14.0, size * 1.8))
            stacked = (x_overlap >= min(a.width, b.width) * .15
                       and y_gap <= max(1.5, size * .18))
            number_touch = ((a_number_only or b_number_only)
                            and x_gap <= max(20.0, size * 2.0)
                            and y_gap <= max(8.0, size * .9))
            if same_row or stacked or number_touch:
                union(i, j)

    groups = {}
    for i in candidates:
        groups.setdefault(find(i), []).append(i)
    merged_at, consumed = {}, set()
    for ids in groups.values():
        if len(ids) < 2 or not any(blocks[i].get("math") for i in ids):
            continue
        # A component must contain an equation anchor, not merely nearby symbols.
        joined = " ".join(blocks[i].get("text", "") for i in ids)
        if not (EQUATION_RE.search(joined) or re.search(r"\(\d+\)", joined)
                or any(ch in joined for ch in "∑∫∏")):
            continue
        # Source order is generally the intended textual order even when a tall
        # fraction starts slightly above the expression to its left.
        ordered = sorted(ids)
        rect = fitz.Rect(blocks[ordered[0]]["bbox"])
        for i in ordered[1:]:
            rect |= fitz.Rect(blocks[i]["bbox"])
        first = min(ids)
        merged = dict(blocks[first])
        merged["bbox"] = [round(v, 2) for v in rect]
        merged["text"] = " ".join(blocks[i].get("text", "") for i in ordered)
        merged["translation_text"] = merged["text"]
        merged["inline_math"] = []
        merged["math"] = True
        merged["skip"] = False
        merged["_whole_math"] = True
        merged["font_size"] = round(sum(float(blocks[i].get("font_size") or 10) for i in ids) / len(ids), 2)
        merged_at[first] = merged
        consumed.update(ids)

    if not consumed:
        return blocks
    return [merged_at[i] if i in merged_at else block
            for i, block in enumerate(blocks) if i not in consumed or i in merged_at]


def _attach_formula_drawings(page, blocks):
    """TeX 分数线/根号横线可能是矢量路径，也要随公式原图一起搬运。"""
    try:
        drawings = page.get_drawings()
    except Exception:
        return
    for block in blocks:
        if block.get("math") or block.get("skip"):
            continue
        for formula in block.get("inline_math", []):
            for part in formula.get("parts", [formula]):
                bounds = fitz.Rect(part["bbox"])
                tolerance = part["font_size"] * 0.15
                area = bounds + (-tolerance, -tolerance, tolerance, tolerance)
                for drawing in drawings:
                    if drawing.get("type") not in ("s", "fs"):
                        continue
                    r = fitz.Rect(drawing["rect"])
                    width = float(drawing.get("width") or 0.5)
                    if (width > part["font_size"] * 0.15
                            or not area.contains(r)
                            or max(r.width, r.height) <= 0):
                        continue
                    pad = width / 2 + 0.15
                    clip = r + (-pad, -pad, pad, pad)
                    clip &= page.rect
                    if clip.is_empty:
                        continue
                    part.setdefault("clips", [part["bbox"]]).append([round(v, 3) for v in clip])
                    bounds |= clip
                part["bbox"] = [round(v, 3) for v in bounds]


def _compose_visual_line(group, math_offset=0):
    """把视觉行排成可翻译文本，并把上下标规范化为 LaTeX 风格纯文本。"""
    spans = []
    bbox = None
    order = 0
    for line in group:
        r = fitz.Rect(line["bbox"])
        bbox = r if bbox is None else bbox | r
        for span in line.get("spans", []):
            if not span.get("text", ""):
                continue
            item = dict(span)
            item["_order"] = order
            item["_bbox"] = fitz.Rect(span["bbox"])
            item["_origin_y"] = _span_baseline(span)
            spans.append(item)
            order += 1
    if not spans:
        return None

    if not _is_horizontal(group[0]):
        # 竖排/旋转标签没有水平基线，不能套用上下标拼接或按 x 排序。
        text = re.sub(r"\s+", " ", "".join(s["text"] for s in spans)).strip()
        return {"spans": spans, "bbox": list(bbox), "text": text, "rotated": True,
                "translation_text": text, "inline_math": []}

    weighted_sizes = []
    for s in spans:
        weighted_sizes.extend([float(s.get("size") or 10)] * max(1, len(s.get("text", "").strip())))
    weighted_sizes.sort()
    body_size = weighted_sizes[len(weighted_sizes) // 2] if weighted_sizes else 10.0
    # Superscript-heavy dimensions must not make the base letter's font shrink.
    normal_sizes = [float(s.get("size") or 10) for s in spans
                    if s.get("text", "").strip() and s["text"].strip() not in "√∑∫∏"]
    if normal_sizes and body_size < max(normal_sizes) * .82:
        body_size = max(normal_sizes)
    baseline_votes = []
    for s in spans:
        if float(s.get("size") or 10) >= body_size * .85 and s.get("text", "").strip() not in "√∑∫∏":
            baseline_votes.extend([s["_origin_y"]] * max(1, len(s["text"].strip())))
    baseline_votes.sort()
    baseline = baseline_votes[len(baseline_votes) // 2] if baseline_votes else group[0]["spans"][0]["origin"][1]

    scripts = {}
    attached = set()
    for i, s in enumerate(spans):
        text = s.get("text", "").strip()
        if not text or float(s.get("size") or 10) > body_size * 0.82:
            continue
        candidates = []
        for j, base in enumerate(spans):
            # A script must be smaller than its base. In nested dimensions a
            # 7pt multiplication sign is not a superscript of the preceding 5pt
            # subscript; attaching it there used to silently drop that glyph.
            if (j == i or not base.get("text", "").strip() or not _span_is_math_base(base)
                    or float(base.get("size") or 10) * .82 < float(s.get("size") or 10)):
                continue
            gap = s["_bbox"].x0 - base["_bbox"].x1
            if -1.5 <= gap <= body_size * 0.65:
                candidates.append((abs(gap), -base["_bbox"].x1, j, base))
        if not candidates:
            continue
        _, _, j, base = min(candidates)
        delta = ((s["_bbox"].y0 + s["_bbox"].y1) / 2
                 - (base["_bbox"].y0 + base["_bbox"].y1) / 2)
        if delta < -body_size * 0.10:
            kind = "sup"
        elif delta > body_size * 0.10:
            kind = "sub"
        else:
            continue
        scripts.setdefault(j, {"sub": [], "sup": []})[kind].append(s)
        attached.add(i)

    def composed_piece(i):
        s = spans[i]
        text = s.get("text", "")
        x1 = s["_bbox"].x1
        script_spans = []
        if i in scripts:
            sc = scripts[i]
            trailing = text[len(text.rstrip()):]
            text = text.rstrip()
            # Descendants of an attached script still contribute text AND crop
            # rectangles. Strictly decreasing font sizes above prevent cycles.
            for kind in ("sub", "sup"):
                parts = []
                for child in sorted(sc[kind], key=lambda x: x["_bbox"].x0):
                    child_text, child_x1, descendants = composed_piece(child["_order"])
                    parts.append(child_text)
                    script_spans.extend([child] + descendants)
                    x1 = max(x1, child_x1)
                text += _format_script(kind, "".join(parts))
            text += trailing
        return text, x1, script_spans

    pieces = []
    formula_pieces = []
    for i, s in enumerate(spans):
        if i in attached:
            continue
        text, x1, script_spans = composed_piece(i)
        pieces.append((s["_bbox"].x0, x1, s["_order"], text))
        formula_pieces.extend(_formula_pieces(s, text, script_spans, body_size))
    pieces.sort(key=lambda x: (x[0], x[2]))

    out = ""
    prev_x1 = None
    for x0, x1, _, text in pieces:
        if not text:
            continue
        first = text.lstrip()[:1]
        if (out and not out[-1].isspace() and not text[0].isspace()
                and prev_x1 is not None and x0 - prev_x1 > 0.5
                and first not in ",.;:!?)]}-"):
            out += " "
        out += text
        prev_x1 = max(prev_x1 or x1, x1)
    out = re.sub(r"\s+", " ", out).strip()
    out = re.sub(r"\s+([,.;:!?])", r"\1", out)
    out = re.sub(r"(?<=[0-9}])\s+-([A-Za-z])", r"-\1", out)
    formula_pieces.sort(key=lambda p: p["x0"])
    translation_text, inline_math = _build_inline_template(formula_pieces, body_size, math_offset, baseline)
    restored = translation_text
    for formula in inline_math:
        restored = restored.replace(formula["token"], formula["text"])
    if re.sub(r"\s", "", restored) != re.sub(r"\s", "", out):
        # 复杂跨基线结构若不能可靠对齐，保留原来的文本通路，不能擅自调换正文顺序。
        translation_text, inline_math = out, []
    return {"spans": spans, "bbox": list(bbox), "text": out,
            "translation_text": translation_text if inline_math else out, "inline_math": inline_math}


def _repair_radical_boxes(doc, page, raw, cache):
    """Measure radicals and TeX extensible delimiters using their actual ink.

    Render only the embedded glyph in a disposable in-memory PDF. This cannot
    capture adjacent prose and is cached per embedded font for the entire PDF.
    The real document is neither edited nor rasterized into the saved PDF.
    """
    fonts = None
    for block in raw.get("blocks", []):
        for line in block.get("lines", []):
            changed = False
            for span in line.get("spans", []):
                extensible = "cmex" in span.get("font", "").lower()
                targets = {c["c"] for c in span.get("chars", []) if c["c"].strip() and (extensible or c["c"] == "√")}
                if not targets or not _is_horizontal(line):
                    continue
                if fonts is None:
                    fonts = page.get_fonts()
                matches = [f for f in fonts if f[3].split("+")[-1] == span["font"].split("+")[-1]]
                if len(matches) != 1:
                    continue
                for char_text in targets:
                    key = (matches[0][0], char_text)
                    if key not in cache:
                        cache[key] = None
                        try:
                            font = fitz.Font(fontbuffer=doc.extract_font(key[0])[3])
                            if not font.has_glyph(ord(char_text)):
                                continue
                            with fitz.open() as glyph_doc:
                                glyph_page = glyph_doc.new_page(width=200, height=256)
                                writer = fitz.TextWriter(glyph_page.rect)
                                writer.append((64, 64), char_text, font=font, fontsize=32)
                                writer.write_text(glyph_page)
                                pix = glyph_page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=True)
                                ink = [i for i, alpha in enumerate(pix.samples[3::4]) if alpha > 0]
                                if ink:
                                    xs, ys = [i % pix.width for i in ink], [i // pix.width for i in ink]
                                    cache[key] = ((min(xs) / 2 - 64) / 32, (min(ys) / 2 - 64) / 32,
                                                  ((max(xs) + 1) / 2 - 64) / 32, ((max(ys) + 1) / 2 - 64) / 32)
                        except (RuntimeError, ValueError, OSError):
                            continue  # Unavailable font: retain the original extraction.
                for char in span["chars"]:
                    bounds = cache.get((matches[0][0], char["c"]))
                    if bounds is not None:
                        x, y = char["origin"]
                        size = span["size"]
                        char["bbox"] = tuple(fitz.Rect(x + bounds[0] * size, y + bounds[1] * size,
                                                       x + bounds[2] * size, y + bounds[3] * size) + (-.15, -.15, .15, .15))
                span["bbox"] = tuple(_rect_union([c["bbox"] for c in span["chars"]]))
                changed = True
            if changed:
                line["bbox"] = tuple(_rect_union([s["bbox"] for s in line["spans"]]))


def _rect_union(rects):
    result = fitz.Rect(rects[0])
    for rect in rects[1:]:
        result |= fitz.Rect(rect)
    return result


def _remove_margin_line_numbers(raw):
    """Remove small, sequential margin labels BEFORE they join the body rows.

    Numbers in equations, citations and tables are not removed by their value or
    font size alone: require an aligned, increasing run outside the prose bounds.
    """
    all_lines = [ln for b in raw.get("blocks", []) for ln in b.get("lines", []) if _is_horizontal(ln)]
    prose = [ln for ln in all_lines if len(re.findall(r"[A-Za-z]{2,}", "".join(s["text"] for s in ln["spans"]))) >= 5
             and ln["bbox"][2] - ln["bbox"][0] > 120]
    if not prose:
        return
    left = min(ln["bbox"][0] for ln in prose)
    right = max(ln["bbox"][2] for ln in prose)
    body_size = sorted(_raw_line_baseline(ln)[1] for ln in prose)[len(prose) // 2]
    candidates = []
    for ln in all_lines:
        text = "".join(s["text"] for s in ln["spans"]).strip()
        r = fitz.Rect(ln["bbox"])
        if (re.fullmatch(r"\d{1,4}", text) and _raw_line_baseline(ln)[1] < body_size * .86
                and (r.x1 < left - body_size * .5 or r.x0 > right + body_size * .5)):
            candidates.append((ln, int(text)))
    groups = []
    for ln, number in sorted(candidates, key=lambda item: item[0]["bbox"][0]):
        if groups and abs(ln["bbox"][0] - groups[-1][0][0]["bbox"][0]) < 3:
            groups[-1].append((ln, number))
        else:
            groups.append([(ln, number)])
    removed = set()
    for group in groups:
        group.sort(key=lambda item: item[0]["bbox"][1])
        steps = sum(b[1] == a[1] + 1 and b[0]["bbox"][1] > a[0]["bbox"][1] + 2
                    for a, b in zip(group, group[1:]))
        if len(group) >= 5 and steps >= (len(group) - 1) * .8:
            for a, b in zip(group, group[1:]):
                if b[1] == a[1] + 1 and b[0]["bbox"][1] > a[0]["bbox"][1] + 2:
                    removed.update((id(a[0]), id(b[0])))
    for block in raw.get("blocks", []):
        if "lines" in block:
            block["lines"] = [ln for ln in block["lines"] if id(ln) not in removed]
            if block["lines"]:
                block["bbox"] = tuple(_rect_union([ln["bbox"] for ln in block["lines"]]))


def _math_only_source(block):
    spans = [s for ln in block.get("lines", []) for s in ln["spans"] if s.get("text", "").strip()]
    if not spans or not all(_is_horizontal(ln) for ln in block["lines"]):
        return False
    # CMR spells operator names in math mode, but many TeX papers also use CMR
    # for every word of the body.  Do not discard the whole CMR family here:
    # doing so makes a long paragraph containing one CMMI/CMSY symbol look like
    # a math-only source block.  Count all full-size, non-dedicated Roman spans
    # and only allow the small vocabulary that legitimately occurs in formulas.
    main_size = max((float(s.get("size") or 10) for s in spans
                     if "cmex" not in s.get("font", "").lower()), default=10.0)
    prose = " ".join(s["text"] for s in spans if not _dedicated_math_span(s)
                     and "cmex" not in s.get("font", "").lower()
                     and float(s.get("size") or 10) >= main_size * .90)
    raw_words = re.findall(r"[A-Za-z]{2,}", prose)
    words = [word.lower() for word in raw_words]
    # A short prose fragment such as the wrapped suffix 'ments:' is still
    # prose, not an operator. Small subscripts such as 'sort' are not prose;
    # among full-size words only allow conventional formula connectors.
    operators = {"where", "and", "for", "mod", "relu", "softmax", "sigmoid", "tanh",
                 "log", "exp", "max", "min", "sin", "cos", "concat", "attention"}
    # A display equation can contain an uppercase function name (FFN,
    # MultiHead), but an unknown lower-case Roman word is almost always prose.
    # This also catches wrapped suffixes such as ``ments:`` that happen to
    # share a raw PDF block with the equation beginning on the same line.
    if any(word.lower() not in operators and word[:1].islower() for word in raw_words):
        return False
    source_text = " ".join(s["text"] for s in spans)
    formula_syntax = bool(EQUATION_RE.search(source_text)
                          or re.search(r"\(\d+\)\s*$", source_text))
    return (len(words) <= 4
            and (all(word in operators for word in words) or formula_syntax)
            and any(_dedicated_math_span(s) for s in spans))


def _assemble_display_sources(raw):
    """Join only overlapping math-only PDF blocks, then keep their 2D layout.

    TeX may put the denominator and closing bracket in another PDF text block.
    Preserve the resulting equation as one crop; do not independently flow its
    apparent text rows or discard an isolated equation number.
    """
    output = []
    for block in raw.get("blocks", []):
        if block.get("type") != 0 or not block.get("lines"):
            output.append(block)
            continue
        is_math = _math_only_source(block)
        if output and is_math and output[-1].get("_math_source"):
            prev = output[-1]
            a, b = fitz.Rect(prev["bbox"]), fitz.Rect(block["bbox"])
            if a.intersects(b):
                prev["lines"].extend(block["lines"])
                prev["bbox"] = tuple(a | b)
                continue
        output.append(dict(block, _math_source=is_math))
    for block in output:
        if not block.get("_math_source"):
            continue
        text = " ".join(s["text"] for ln in block["lines"] for s in ln["spans"])
        block["_whole_math"] = bool("=" in text or re.search(r"\(\d+\)\s*$", text))
    raw["blocks"] = output


def _extract_page(doc, pno, glyph_bounds=None):
    page = doc[pno]
    d = page.get_text("rawdict")
    _repair_radical_boxes(doc, page, d, glyph_bounds if glyph_bounds is not None else {})
    for b in d.get("blocks", []):
        for ln in b.get("lines", []):
            for span in ln["spans"]:
                span["text"] = "".join(c["c"] for c in span.get("chars", []))
    _remove_margin_line_numbers(d)
    _assemble_display_sources(d)
    lines = []
    math_offset = 0
    for source_block, b in enumerate(d.get("blocks", [])):
        if b.get("type") != 0:  # 只要文本块，图片块跳过
            continue
        visual_lines = []
        groups = [b["lines"]] if b.get("_whole_math") else _group_visual_lines(b.get("lines", []))
        for group in groups:
            composed = _compose_visual_line(group, math_offset)
            if composed:
                if b.get("_whole_math"):
                    composed["bbox"] = list((fitz.Rect(composed["bbox"]) + (-.35, -.35, .35, .35)) & page.rect)
                math_offset += len(composed["inline_math"])
                visual_lines.append(composed)
        for ln in visual_lines:
            spans = ln.get("spans", [])
            text = ln.get("text", "")
            text = re.sub(r"\s+", " ", text).strip()
            if not text:
                continue
            # 没有任何字母/数字/中文的行跳过（纯图形符号）
            if not any(ch.isalnum() for ch in text) and not re.search(r"[\u4e00-\u9fff]", text):
                continue
            # 按字符数加权统计样式（避免行内个别加粗字符影响整行判断）
            size_num = size_den = 0.0
            color_w = {}
            font_w = {}
            bold_chars = italic_chars = total = 0
            for s in spans:
                t = s.get("text", "").strip()
                if not t:
                    continue
                n = len(t)
                total += n
                size_num += (s.get("size") or 10) * n
                size_den += n
                c = s.get("color") or 0
                color_w[c] = color_w.get(c, 0) + n
                fn = s.get("font") or ""
                font_w[fn] = font_w.get(fn, 0) + n
                fl = s.get("flags") or 0
                if fl & 16:
                    bold_chars += n
                if fl & 2:
                    italic_chars += n
            if total == 0:
                continue
            size = size_num / size_den
            bbox = [round(v, 2) for v in ln["bbox"]]
            w = bbox[2] - bbox[0]
            h = bbox[3] - bbox[1]
            # 跳过竖排细长块（页边水印、图表内的旋转文字）：不翻译、不擦除，保持原样
            if h > 4 * w and h > 60:
                continue
            font = max(font_w.items(), key=lambda kv: kv[1])[0] if font_w else ""
            lines.append({
                "bbox": bbox,
                "font_size": round(size_num / size_den, 2),
                "bold": bold_chars > total * 0.5,
                "italic": italic_chars > total * 0.5,
                "color": max(color_w.items(), key=lambda kv: kv[1])[0],
                "font": font,
                "math": bool(b.get("_whole_math")) or _is_math_line(text, font),
                "_whole_math": bool(b.get("_whole_math")),
                "skip": bool(ln.get("rotated")),
                "text": text,
                "translation_text": ln["translation_text"],
                "inline_math": ln["inline_math"],
                "_source_block": source_block,
                **({"rotated": True} if ln.get("rotated") else {}),
            })
    _mark_float_lines(lines, page.rect.width)
    tables = _ruled_table_regions(page)
    algorithms = _ruled_algorithm_regions(page)
    for ln in lines:
        rect = fitz.Rect(ln["bbox"])
        for table_id, table in enumerate(tables):
            if abs(rect) and abs(rect & table) >= abs(rect) * .8:
                ln["skip"] = True
                ln["_table_region"] = table_id + 1
                break
        for algorithm_id, algorithm in enumerate(algorithms):
            if abs(rect) and abs(rect & algorithm) >= abs(rect) * .8:
                ln["skip"] = True
                ln["math"] = False
                ln["_algorithm_region"] = algorithm_id + 1
                break
    blocks = _merge_lines(lines)
    # 先纠正公式/表格启发式对长正文的误判，再应用图片保护区；否则图片内的
    # 长说明文字会被兜底逻辑重新放回翻译队列。
    _unmark_body_paragraphs(blocks, page.rect.width)
    protected = _protected_rects(page, tables, algorithms)
    _mark_image_text(blocks, protected)
    _mark_references(blocks)
    blocks = _merge_display_math_fragments(blocks, page.rect.width)
    blocks = _merge_formula_continuations(blocks)
    _attach_formula_drawings(page, blocks)
    for i, b in enumerate(blocks):
        b["id"] = i
        b.pop("_source_block", None)
        b.pop("_whole_math", None)
        b.pop("_table_region", None)
        b.pop("_algorithm_region", None)
        rect = fitz.Rect(b["bbox"])
        if (b.get("math") and not b.get("skip") and not page.rotation
                and not any(abs(rect & fitz.Rect(r)) > abs(rect) * .25 for r in protected)):
            b["display_math"] = True
        if b.get("math") or b.get("skip") or page.rotation:
            b.pop("inline_math", None)
            b.pop("translation_text", None)
        elif not b.get("inline_math"):
            b.pop("inline_math", None)
            b.pop("translation_text", None)
    return {
        "page": pno,
        "width": round(page.rect.width, 2),
        "height": round(page.rect.height, 2),
        "rotation": int(page.rotation or 0),
        "blocks": blocks,
        "protected": protected,
    }


def _page_lines(page):
    """按 y 排序的页面行信息（含字号与加粗判断），供区域检测使用。"""
    d = page.get_text("dict")
    lines = []
    for b in d.get("blocks", []):
        if b.get("type") != 0:
            continue
        for ln in b.get("lines", []):
            spans = ln.get("spans", [])
            text = "".join(s.get("text", "") for s in spans)
            text = re.sub(r"\s+", " ", text).strip()
            if not text:
                continue
            size_num = size_den = 0.0
            bold_chars = total = 0
            for s in spans:
                t = s.get("text", "").strip()
                if not t:
                    continue
                n = len(t)
                total += n
                size_num += (s.get("size") or 10) * n
                size_den += n
                if (s.get("flags") or 0) & 16:
                    bold_chars += n
            if total == 0:
                continue
            lines.append({
                "bbox": [round(v, 2) for v in ln["bbox"]],
                "text": text,
                "size": size_num / size_den,
                "bold": bold_chars > total * 0.5,
                "dir": ln.get("dir", (1.0, 0.0)),
            })
    lines.sort(key=lambda x: x["bbox"][1])
    return lines


def _caption_regions(page, tables=None, algorithms=None):
    """以 Table/Figure/Algorithm 标题为锚点，按栏向下扫描，返回该区块的包围盒。

    表格/算法框：向下收集同栏的密集行（单元格/伪代码），到加粗标题或大间距停止。
    图注：只保留标题段本身（图本身由矢量矩形保护区覆盖）。
    """
    lines = _page_lines(page)
    if not lines:
        return []
    xs = [l["bbox"][0] for l in lines]
    xe = [l["bbox"][2] for l in lines]
    mid = (min(xs) + max(xe)) / 2
    sizes = sorted(l["size"] for l in lines if l["size"] < 14)
    body = sizes[len(sizes) // 2] if sizes else 10
    regions = []
    tables = _ruled_table_regions(page) if tables is None else tables
    algorithms = _ruled_algorithm_regions(page) if algorithms is None else algorithms
    for i, ln in enumerate(lines):
        # 只处理表格/算法标题的区域；图注不在这里生成（避免向下扫过正文吞并段落）。
        # 无标点的 "Table N Title" 只有在附近已经检测到带横线的数值表时才成立。
        caption = fitz.Rect(ln["bbox"])
        if ALGO_START_RE.match(ln["text"]) and any(abs(caption & r) >= abs(caption) * .8 for r in algorithms):
            continue  # Exact ruled boundary already covers the complete algorithm.
        table = next((r for r in tables if TABLE_START_RE.match(ln["text"]) and
                      min(r.x1, caption.x1) - max(r.x0, caption.x0) >= min(r.width, caption.width) * .6
                      and (0 <= caption.y0 - r.y1 <= 32 or 0 <= r.y0 - caption.y1 <= 65)), None)
        if not (TABLE_CAPTION_RE.match(ln["text"]) or ALGO_START_RE.match(ln["text"]) or table is not None):
            continue
        if table is not None:
            # Table bounds are known: only collect tightly spaced caption lines.
            # A below-table caption must never scan onward into the next paragraph.
            for nb in lines[i + 1:]:
                rect = fitz.Rect(nb["bbox"])
                if abs(rect.x0 - caption.x0) > 12:
                    continue
                gap = rect.y0 - caption.y1
                if (gap > max(3, ln["size"] * .65) or rect.intersects(table)
                        or abs(nb["size"] - ln["size"]) > 1 or nb["bold"]):
                    break
                if gap >= -1:
                    caption |= rect
            regions.append(list(caption))
            continue
        leftcol = ln["bbox"][0] < mid
        prev_y1 = ln["bbox"][3]
        ys = [ln["bbox"][1], ln["bbox"][3]]
        xs2 = [ln["bbox"][0], ln["bbox"][2]]
        seen_cell = False
        row_ys = {round(ln["bbox"][1], 1)}
        col_w = max(1.0, max(xs2) - min(xs2))
        for j in range(i + 1, len(lines)):
            nb = lines[j]
            bb = nb["bbox"]
            if (bb[0] < mid) != leftcol:
                continue  # 跳过异栏行
            if nb["bold"] and nb["size"] > body + 1.0:
                break  # 新加粗标题
            gap = bb[1] - prev_y1
            if gap > 26:
                break
            # 同一 y 已有行 → 出现表格行（多单元格）；否则单行视为 caption 段落
            y0r = round(bb[1], 1)
            if any(abs(y0r - r) <= 3 for r in row_ys):
                seen_cell = True
            row_ys.add(y0r)
            col_w = max(col_w, bb[2] - bb[0])
            # 表格主体开始后，遇到宽长正文行 → 停止（避免吞并其后正文）
            if seen_cell and len(nb["text"]) > 38 and (bb[2] - bb[0]) > col_w * 0.8:
                break
            ys += [bb[1], bb[3]]
            xs2 += [bb[0], bb[2]]
            prev_y1 = max(prev_y1, bb[3])
        if max(ys) - min(ys) > 4:
            regions.append([min(xs2), min(ys), max(xs2), max(ys)])
    return regions


def _clipped_drawings(page):
    """返回实际可见图元和它们的裁剪框，而不是裁剪前可能伸进正文的路径范围。

    extended 路径流用 level 表示 clip/group 的嵌套范围。同级或更低级的新
    项目会结束旧 clip；group 本身不是图形，不能把它的未裁剪 bbox 加入保护区。
    """
    active = []
    drawings = []
    clips = set()
    for item in page.get_drawings(extended=True):
        level = item["level"]
        active = [(lv, r) for lv, r in active if lv < level]
        if item["type"] == "clip":
            effective = fitz.Rect(item["scissor"]) & page.rect
            for _, parent in active:
                effective &= parent
            active.append((level, effective))
            continue
        if item["type"] not in ("s", "f", "fs"):
            continue
        r = fitz.Rect(item["rect"])
        if max(r.width, r.height) <= 1:
            continue
        # 先给零宽/零高线段留出笔画宽度，再裁剪；反过来会丢失坐标轴等线段。
        r = fitz.Rect(r.x0 - 1, r.y0 - 1, r.x1 + 1, r.y1 + 1) & page.rect
        for _, clip in active:
            r &= clip
        if r.is_empty:
            continue
        drawings.append(dict(item, rect=r))
        clips.update(tuple(clip) for _, clip in active)
    return drawings, [fitz.Rect(r) for r in sorted(clips)]


def _figure_clip_regions(page, clips, graphics):
    """用紧邻图注、确实含图形的局部裁剪框补全图例、轴标题和刻度。

    不能把任意 clip 都当作图片：页面级 clip 会吞掉正文。这里要求图注锚点，
    并排除框内含正常字号长正文的候选；裁剪框只负责补全已检测到的图形。
    """
    lines = _page_lines(page)
    captions = [ln for ln in lines if FIG_CAPTION_RE.match(ln["text"]) and _is_horizontal(ln)]
    regions = []
    for r in clips:
        if r.width <= 40 or r.height <= 26 or not any(r.intersects(g) for g in graphics):
            continue
        for caption in captions:
            cb = fitz.Rect(caption["bbox"])
            overlap = min(r.x1, cb.x1) - max(r.x0, cb.x0)
            if not (-0.5 <= cb.y0 - r.y1 <= max(24, caption["size"] * 2)):
                continue
            if overlap < min(r.width, cb.width) * 0.8 or r.width > cb.width * 1.35:
                continue
            has_prose = any(
                _is_horizontal(ln) and ln["size"] >= caption["size"] * 0.9
                and len(re.findall(r"[A-Za-z]{2,}", ln["text"])) >= 7
                and abs(fitz.Rect(ln["bbox"]) & r) > abs(fitz.Rect(ln["bbox"])) * 0.5
                for ln in lines if not FIG_CAPTION_RE.match(ln["text"])
            )
            if not has_prose:
                regions.append(r)
                break
    return regions


def _ruled_table_regions(page):
    """Caption + aligned horizontal rules + numeric rows identify open tables.

    Academic tables often have no vertical borders and their caption is below
    the data. Neither PDF table finders nor downward caption scans cover these.
    Require all three signals so charts, page headers and nearby prose stay out.
    """
    lines = _page_lines(page)
    # Structural evidence below (aligned rules + numeric rows) makes the broad
    # caption form safe here, including captions without a colon or full stop.
    captions = [fitz.Rect(ln["bbox"]) for ln in lines if TABLE_START_RE.match(ln["text"])]
    if not captions:
        return []
    rules = []
    for drawing in page.get_drawings():
        r = fitz.Rect(drawing["rect"])
        if r.width >= max(80, page.rect.width * .18) and r.height <= 2:
            rules.append(r)
    groups = []
    for r in sorted(rules, key=lambda r: r.y0):
        group = next((g for g in groups if abs(g[0].x0 - r.x0) <= 3
                      and abs(g[0].x1 - r.x1) <= 3 and r.y0 - g[-1].y1 <= 65), None)
        if group is None:
            groups.append([r])
        else:
            group.append(r)
    regions = []
    words = page.get_text("words")
    for group in groups:
        if len({round(r.y0) for r in group}) < 3:
            continue
        rect = fitz.Rect(min(r.x0 for r in group), group[0].y0 - 1,
                         max(r.x1 for r in group), group[-1].y1 + 1)
        if not any(min(rect.x1, c.x1) - max(rect.x0, c.x0) >= min(rect.width, c.width) * .6
                   and (0 <= c.y0 - rect.y1 <= 32 or 0 <= rect.y0 - c.y1 <= 65) for c in captions):
            continue
        numeric = [w for w in words if re.fullmatch(r"[−+\-]?\d+(?:\.\d+)?%?", w[4])
                   and rect.contains(fitz.Point((w[0] + w[2]) / 2, (w[1] + w[3]) / 2))]
        rows = []
        for w in sorted(numeric, key=lambda w: w[1]):
            if not rows or abs(w[1] - rows[-1][0][1]) > 4:
                rows.append([w])
            else:
                rows[-1].append(w)
        if sum(len(row) >= 2 for row in rows) < 2:
            continue
        if any(rect.contains(fitz.Rect(ln["bbox"])) and len(re.findall(r"\b[A-Za-z]{2,}\b", ln["text"])) >= 12
               for ln in lines):
            continue
        regions.append(rect & page.rect)
    return regions


def _ruled_algorithm_regions(page):
    """Use an algorithm environment's own horizontal rules as exact bounds.

    TeX pseudocode is frequently split into unrelated text objects. Scanning
    downward from the caption stops early on long Input/for/if lines; the top,
    caption separator and bottom rules are a much stronger structural signal.
    """
    lines = _page_lines(page)
    captions = [ln for ln in lines if ALGO_START_RE.match(ln["text"])]
    if not captions:
        return []
    rules = []
    for drawing in page.get_drawings():
        r = fitz.Rect(drawing["rect"])
        if r.width >= max(80, page.rect.width * .18) and r.height <= 2:
            rules.append(r)
    regions = []
    for caption in captions:
        c = fitz.Rect(caption["bbox"])
        top_candidates = [r for r in rules if r.x0 <= c.x0 + 3 and r.x1 >= c.x1 - 3
                          and 0 <= c.y0 - r.y0 <= 8]
        if not top_candidates:
            continue
        top = max(top_candidates, key=lambda r: r.y0)
        aligned = sorted((r for r in rules if abs(r.x0 - top.x0) <= 3 and abs(r.x1 - top.x1) <= 3),
                         key=lambda r: r.y0)
        separators = [r for r in aligned if 0 <= r.y0 - c.y1 <= 12]
        if not separators:
            continue
        separator = min(separators, key=lambda r: r.y0)
        bottoms = [r for r in aligned if separator.y1 + 12 <= r.y0 <= top.y0 + 260]
        if not bottoms:
            continue
        bottom = min(bottoms, key=lambda r: r.y0)
        interior = [ln for ln in lines if separator.y1 <= ln["bbox"][1] <= bottom.y0
                    and top.x0 - 3 <= ln["bbox"][0] and ln["bbox"][2] <= top.x1 + 3]
        if len(interior) < 2 or not any(re.match(r"\s*(?:Input|Output|Desc\.|\d+\s*:)", ln["text"], re.I)
                                        for ln in interior):
            continue
        regions.append(fitz.Rect(top.x0 - .4, top.y0 - .4, top.x1 + .4, bottom.y1 + .4) & page.rect)
    return regions


def _protected_rects(page, tables=None, algorithms=None):
    """页面中不可覆盖内容（图片、大矢量图、表格、图注、算法框）的包围盒。

    重排时文字要避开，且其中的文字/内容不翻译、不擦除。
    """
    tables = _ruled_table_regions(page) if tables is None else tables
    algorithms = _ruled_algorithm_regions(page) if algorithms is None else algorithms
    rects = list(tables) + list(algorithms)
    # 1) 图片放置位置（type==1 图像块，最贴合实际渲染位置）
    try:
        d = page.get_text("dict")
        for b in d.get("blocks", []):
            if b.get("type") == 1:
                r = fitz.Rect(b["bbox"])
                if r.width > 8 and r.height > 8:
                    rects.append(r)
    except Exception:
        pass
    # 2) 补充：get_image_rects（覆盖某些未以 type==1 出现的图片）
    try:
        for img in page.get_images(full=True):
            for r in page.get_image_rects(img[0]):
                r = fitz.Rect(r)
                if r.width > 8 and r.height > 8:
                    rects.append(r)
    except Exception:
        pass
    # 3) 矢量图（示意图/流程图/算法框）。不能直接采用白色背景矩形：
    # 某些论文的背景框远大于实际图形，会把下方正文一起裁回译文页。
    try:
        drawing_groups = []
        drawings, clips = _clipped_drawings(page)
        for dr in drawings:
            fill = dr.get("fill")
            if (dr.get("type") == "f" and fill and min(fill) >= 0.98
                    and dr.get("color") is None):
                continue  # 纯白背景，不是需要保护的可见图形
            r = fitz.Rect(dr["rect"])
            rr = r  # 笔画扩张和 PDF 裁剪已在 _clipped_drawings 中完成。
            hits = []
            for gi, g in enumerate(drawing_groups):
                expanded = fitz.Rect(g["rect"].x0 - 4, g["rect"].y0 - 4,
                                     g["rect"].x1 + 4, g["rect"].y1 + 4)
                if expanded.intersects(rr):
                    hits.append(gi)
            if not hits:
                drawing_groups.append({"rect": rr, "count": 1})
            else:
                base = hits[0]
                drawing_groups[base]["rect"] |= rr
                drawing_groups[base]["count"] += 1
                for gi in reversed(hits[1:]):
                    drawing_groups[base]["rect"] |= drawing_groups[gi]["rect"]
                    drawing_groups[base]["count"] += drawing_groups[gi]["count"]
                    del drawing_groups[gi]
        graphics = []
        for g in drawing_groups:
            r = g["rect"]
            if r.width > 40 and r.height > 20 and g["count"] >= 3:
                graphics.append(r)
            elif r.width > 40 and r.height > 26:
                graphics.append(r)
        rects.extend(graphics)
        rects.extend(_figure_clip_regions(page, clips, graphics))
    except Exception:
        pass
    # 4) 表格 / 图注 / 算法框（caption 锚点 + 列感知扫描）
    try:
        for r in _caption_regions(page, tables, algorithms):
            rects.append(fitz.Rect(r))
    except Exception:
        pass
    # 5) 合并重叠矩形，裁剪到页内，丢弃无效区域（drawing bbox 可能略越界）
    merged = _merge_overlapping(rects)
    W, H = page.rect.width, page.rect.height
    out = []
    for r in merged:
        r = fitz.Rect(r)
        r = fitz.Rect(max(r.x0, 0), max(r.y0, 0), min(r.x1, W), min(r.y1, H))
        if r.width > 1 and r.height > 1:
            out.append([round(r.x0, 2), round(r.y0, 2), round(r.x1, 2), round(r.y1, 2)])
    return out


def _merge_overlapping(rects):
    """合并相互重叠的矩形，形成更完整、不碎片化的保护区。"""
    rects = [fitz.Rect(r) for r in rects if r.width > 0 and r.height > 0]
    rects.sort(key=lambda r: (r.x0, r.y0))
    out = []
    for r in rects:
        if out and r.intersects(out[-1]):
            out[-1] = out[-1] | r
        else:
            out.append(fitz.Rect(r))
    return out


def _inside(rect, x, y):
    return rect.x0 <= x <= rect.x1 and rect.y0 <= y <= rect.y1


def _mark_image_text(blocks, protected):
    """正文须基本落在图片内才 skip；短图表标签沿用中心点判断。"""
    if not protected:
        return
    rects = [fitz.Rect(r) for r in protected]
    for b in blocks:
        if b.get("math") or b.get("skip"):
            continue
        bbox = fitz.Rect(b["bbox"])
        area = abs(bbox)
        if area > 0 and any(abs(bbox & r) >= area * 0.8 for r in rects):
            b["skip"] = True
        elif len(re.findall(r"[A-Za-z][A-Za-z'\-]+", b.get("text", ""))) < 5:
            # 行底色只覆盖部分单元格、竖排标签跨过图框时，仍按原有方式保护。
            # 自然语言段落绝不能走这个兜底，否则窄图框会吞掉整栏正文。
            cx, cy = (bbox.x0 + bbox.x1) / 2, (bbox.y0 + bbox.y1) / 2
            if any(_inside(r, cx, cy) for r in rects):
                b["skip"] = True


def _filter_repeated(pages):
    """去掉页眉页脚（多页同位置重复出现的文本）与纯页码块。"""
    n = len(pages)
    cnt = Counter()
    for p in pages:
        seen = set()
        for b in p["blocks"]:
            key = (tuple(b["bbox"]), b["text"])
            if key not in seen:
                seen.add(key)
                cnt[key] += 1
    threshold = max(3, int(n * 0.6))
    for p in pages:
        kept = []
        for b in p["blocks"]:
            if cnt[(tuple(b["bbox"]), b["text"])] >= threshold:
                continue
            if SKIP_RE.fullmatch(b["text"]):
                continue
            kept.append(b)
        for i, b in enumerate(kept):
            b["id"] = i
        p["blocks"] = kept
