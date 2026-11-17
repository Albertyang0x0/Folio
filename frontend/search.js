/* Search the PDF's actual text, retaining character offsets for precise highlights. */
"use strict";

function normalizeSearchText(raw) {
  let text = "";
  const starts = [], ends = [];
  for (let i = 0; i < raw.length;) {
    // A PDF line-end hyphen is not part of the word being searched.
    const wrap = raw[i] === "-" && /^-\s*\n\s*(?=[a-z])/.exec(raw.slice(i));
    if (wrap) { i += wrap[0].length; continue; }
    const char = String.fromCodePoint(raw.codePointAt(i)), end = i + char.length;
    const normalized = char === "\u00ad" ? "" : char.normalize("NFKC").toLowerCase();
    for (const part of normalized) {
      const value = /\s/u.test(part) ? " " : part;
      if (value === " " && text.endsWith(" ")) { ends[ends.length - 1] = end; continue; }
      text += value;
      for (let k = 0; k < value.length; k++) { starts.push(i); ends.push(end); }
    }
    i = end;
  }
  return { text, starts, ends };
}

function buildSearchIndex(content) {
  let text = "";
  const segments = [];
  for (const item of content.items) {
    if (typeof item.str !== "string") continue;
    const start = text.length;
    text += item.str;
    segments.push({ start, end: text.length });
    if (item.hasEOL) text += "\n";
  }
  return { text, segments, normalized: normalizeSearchText(text) };
}

function findSearchMatches(index, query, page) {
  const needle = normalizeSearchText(query).text.trim(), matches = [];
  if (!needle) return matches;
  const { text, starts, ends } = index.normalized;
  for (let pos = text.indexOf(needle); pos !== -1; pos = text.indexOf(needle, pos + needle.length)) {
    const start = starts[pos], end = ends[pos + needle.length - 1];
    matches.push({ page, start, end, idx: start, text: index.text, key: page + ":" + start + ":" + end });
  }
  return matches;
}

const readerSearch = (() => {
  const cache = new WeakMap(), surfaces = new Map();
  let pendingJump = null;

  async function pageIndex(doc, pageNumber) {
    if (!cache.has(doc)) cache.set(doc, new Map());
    const pages = cache.get(doc);
    if (!pages.has(pageNumber)) {
      const request = doc.pdfDoc.getPage(pageNumber + 1).then((page) => page.getTextContent()).then(buildSearchIndex);
      pages.set(pageNumber, request);
      request.catch(() => { if (pages.get(pageNumber) === request) pages.delete(pageNumber); });
    }
    return pages.get(pageNumber);
  }

  async function find(doc, query, isCurrent) {
    const results = [];
    for (let page = 0; page < doc.pagesMeta.length; page++) {
      if (!isCurrent()) return [];
      const index = await pageIndex(doc, page);
      if (!isCurrent()) return [];
      results.push(...findSearchMatches(index, query, page));
    }
    return results;
  }

  function detach(host) {
    const surface = surfaces.get(host);
    if (!surface) return;
    surfaces.delete(host);
    surface.layer.remove();
  }

  function attach(host, doc, page, content, textDivs) {
    detach(host);
    const layer = document.createElement("div");
    layer.className = "search-layer"; layer.setAttribute("aria-hidden", "true");
    host.append(layer);
    const surface = { host, doc, page, layer, textDivs, index: buildSearchIndex(content) };
    surfaces.set(host, surface);
    draw(surface); finishJump();
  }

  function matchKey(match) {
    return match.key ?? [match.scope, match.page, match.blockId, match.idx, match.end].join(":");
  }

  function addHighlight(surface, bounds, match, range) {
    const key = matchKey(match);
    const active = surface.doc.searchMatch && matchKey(surface.doc.searchMatch) === key;
    const rects = range.getClientRects ? range.getClientRects() : [range];
    for (const rect of rects) {
      if (rect.width < 0.2 || rect.height < 0.2) continue;
      const mark = document.createElement("span");
      mark.className = "search-hit" + (active ? " current" : "");
      mark.dataset.matchKey = key;
      Object.assign(mark.style, {
        left: (rect.left - bounds.left) / bounds.width * 100 + "%",
        top: (rect.top - bounds.top) / bounds.height * 100 + "%",
        width: rect.width / bounds.width * 100 + "%", height: rect.height / bounds.height * 100 + "%",
      });
      surface.layer.append(mark);
    }
  }

  function draw(surface) {
    const { doc, host, layer, index, textDivs, translation } = surface;
    layer.replaceChildren();
    if (!host.getClientRects().length) return;
    const bounds = host.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    for (const match of doc.searchResults.filter((item) => item.page === surface.page &&
      (item.scope === "translation") === Boolean(translation))) {
      if (translation) {
        const block = translation.get(match.blockId);
        if (!block) continue;
        const count = layer.childElementCount;
        for (const { span, offsets } of block.spans) {
          const first = offsets.findIndex((offset) => offset >= match.idx && offset < match.end);
          if (first < 0) continue;
          let last = first + 1;
          while (last < offsets.length && (offsets[last] == null || offsets[last] < match.end)) last++;
          const range = document.createRange();
          range.setStart(span.firstChild, first);
          range.setEnd(span.firstChild, last);
          addHighlight(surface, bounds, match, range);
        }
        if (count === layer.childElementCount) {
          const r = block.bounds;
          addHighlight(surface, bounds, match, { left: bounds.left + r.left, top: bounds.top + r.top,
            width: r.right - r.left, height: r.bottom - r.top });
        }
        continue;
      }
      index.segments.forEach((segment, i) => {
        const from = Math.max(segment.start, match.start), to = Math.min(segment.end, match.end);
        const span = textDivs[i];
        if (from >= to || !span || !span.firstChild || !span.isConnected) return;
        const range = document.createRange();
        range.setStart(span.firstChild, from - segment.start);
        range.setEnd(span.firstChild, to - segment.start);
        addHighlight(surface, bounds, match, range);
      });
    }
  }

  function refresh(doc) {
    for (const surface of surfaces.values()) if (surface.doc === doc) draw(surface);
    finishJump();
  }

  function select(doc, match) {
    pendingJump = { doc, key: matchKey(match) };
    refresh(doc);
  }

  function finishJump() {
    if (!pendingJump || cur() !== pendingJump.doc) return;
    for (const surface of surfaces.values()) {
      if (surface.doc !== pendingJump.doc || !surface.host.getClientRects().length) continue;
      const mark = [...surface.layer.children].find((item) => item.dataset.matchKey === pendingJump.key);
      if (!mark) continue;
      const scroller = surface.host.closest(".duo-scroll, .view"), view = scroller.getBoundingClientRect(), box = mark.getBoundingClientRect();
      scroller.scrollTop += box.top + box.height / 2 - view.top - view.height / 2;
      scroller.scrollLeft += box.left + box.width / 2 - view.left - view.width / 2;
      pendingJump = null;
      return;
    }
  }

  // Canvas wraps and trims whitespace. Index the remaining characters back to
  // the corresponding offsets in the original translation returned by the API.
  function compact(text) {
    const offsets = [];
    let result = "";
    for (let i = 0; i < text.length; i++) {
      if (!/\s/u.test(text[i])) {
        result += text[i];
        offsets.push(i);
      }
    }
    return { text: result, offsets };
  }

  function attachTranslation(host, doc, page, textLayer, layout, blocks) {
    detach(host);
    const layer = document.createElement("div");
    layer.className = "search-layer";
    layer.setAttribute("aria-hidden", "true");
    const translation = new Map();
    const plain = new Map(blocks.map((block) => [block.id, compact(block.text)]));
    const content = document.createDocumentFragment();
    for (const [id, bounds] of layout) {
      const block = document.createElement("div");
      block.className = "duo-text-block";
      const spans = [], source = plain.get(id);
      let cursor = 0;
      for (const runs of bounds.lines) {
        const line = document.createElement("div");
        line.className = "duo-text-line";
        for (const run of runs) {
          if (!(run.naturalWidth > 0)) continue;
          const span = document.createElement("span");
          span.textContent = run.text;
          Object.assign(span.style, {
            font: run.font, lineHeight: run.height + "px", top: run.top + "px", left: run.left + "px",
            transform: "scaleX(" + run.width / run.naturalWidth + ")",
          });
          line.append(span);
          const value = compact(run.text);
          const start = source?.text.indexOf(value.text, cursor) ?? -1;
          if (value.text && start >= 0) {
            const offsets = new Array(run.text.length);
            for (const [i, offset] of value.offsets.entries()) offsets[offset] = source.offsets[start + i];
            spans.push({ span, offsets });
            cursor = start + value.text.length;
          }
        }
        block.append(line);
      }
      content.append(block);
      translation.set(id, { spans, bounds });
    }
    textLayer.replaceChildren(content);
    host.append(layer);
    surfaces.set(host, { host, doc, page, layer, translation });
  }

  return { find, attach, attachTranslation, detach, refresh, select, cancelJump: () => { pendingJump = null; } };
})();
