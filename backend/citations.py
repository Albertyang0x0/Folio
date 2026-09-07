"""Protect in-text references as text, not translated prose or formula images."""
import re

TOKEN = re.compile(r"__CITE_\d{4,}__")
YEAR = r"(?:18|19|20)\d{2}[a-z]?(?:\s*,\s*(?:(?:18|19|20)\d{2})?[a-z])?(?![A-Za-z0-9])"
# Names may contain accents, particles and hyphens. Exclude common prose prefixes.
NAME = r"(?!(?:See|In|By|From|Following|Unlike|The|This|Figure|Table|Section)\b)[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]*"
PERSON = rf"{NAME}(?:\s+(?:{NAME}|van|von|de|del|der|den|da|di)){{0,3}}"
AUTHORS = rf"{PERSON}(?:\s+et\s+al\.?|(?:,\s*{PERSON})*(?:,?\s+(?:and|&)\s+{PERSON})?)"
AUTHOR_YEAR = rf"{AUTHORS}\s*,\s*{YEAR}"
ENTRY = re.compile(rf"{AUTHOR_YEAR}")
NARRATIVE = re.compile(rf"\b{AUTHORS}\s*\(\s*{YEAR}(?:\s*[,;]\s*{YEAR})*\s*\)")
NUMBERED = re.compile(r"\[\s*\d+(?:\s*[,;–—\-]\s*\d+)*\s*\]")
PARENS = re.compile(r"\([^()\n]+\)")


def citation_spans(text):
    spans = []
    for match in PARENS.finditer(text):
        items = re.split(r"\s*;\s*", match.group()[1:-1].strip())
        if items and all(ENTRY.fullmatch(item) for item in items):
            spans.append(match.span())
    for pattern in (NARRATIVE, ENTRY, NUMBERED):
        spans.extend(match.span() for match in pattern.finditer(text))

    # A reference can cross a column/page boundary. Protect its visible fragment,
    # without moving content to another column or freezing the surrounding clause.
    tail = re.search(rf"\(?{AUTHORS}\s*,\s*$", text)
    if tail and ("et al" in tail.group() or tail.group().startswith("(")):
        spans.append(tail.span())
    head = re.match(rf"^\s*{YEAR}(?:\s*;\s*{AUTHOR_YEAR})*\s*\)", text)
    if head:
        spans.append(head.span())

    # Keep the largest matching interval (parenthesized lists contain individual entries).
    spans.sort(key=lambda s: (s[0], -s[1]))
    merged = []
    for start, end in spans:
        if merged and start < merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return merged


def mask_citations(text):
    saved, parts, pos = [], [], 0
    reserved = set(TOKEN.findall(text))
    number = 0
    for start, end in citation_spans(text):
        token = f"__CITE_{number:04d}__"
        while token in reserved:
            number += 1
            token = f"__CITE_{number:04d}__"
        number += 1
        parts.extend((text[pos:start], token))
        saved.append((token, text[start:end]))
        pos = end
    parts.append(text[pos:])
    return "".join(parts), saved


def restore_citations(text, saved):
    for token, original in saved:
        text = text.replace(token, original)
    return text


def normalize_translation_spacing(text, target):
    """Clean layout noise outside protected citations/formulas, preserving English word spaces."""
    text = re.sub(r"[\u200b\ufeff]", "", text)
    text = re.sub(r"[^\S\n]+", " ", text)
    text = "\n".join(line.strip() for line in text.splitlines()).strip()
    if "中文" not in target and "chinese" not in target.lower():
        return text
    cjk = r"\u3400-\u9fff"
    text = re.sub(rf"(?<=[{cjk}]) +(?=[{cjk}A-Za-z0-9_（(【\[])", "", text)
    # 数字与中文间的单空格可能是节编号或量值分隔（如「1 引言」），不要一概删除。
    text = re.sub(rf"(?<=[A-Za-z_）)】\]]) +(?=[{cjk}])", "", text)
    text = re.sub(r" +([，。、！？；：,.!?;:）)】\]])", r"\1", text)
    text = re.sub(r"([（(【\[]) +", r"\1", text)
    text = re.sub(r"([，。、！？；：]) +", r"\1", text)
    return text
