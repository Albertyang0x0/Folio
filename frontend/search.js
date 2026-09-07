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
    if (surface.task) surface.task.cancel();
    surface.layer.remove();
    if (surface.ownedText) surface.ownedText.remove();
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

  function draw(surface) {
    const { doc, host, layer, index, textDivs } = surface;
    layer.replaceChildren();
    if (!index || !host.getClientRects().length) return;
    const bounds = host.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    for (const match of doc.searchResults.filter((item) => item.page === surface.page)) {
      index.segments.forEach((segment, i) => {
        const from = Math.max(segment.start, match.start), to = Math.min(segment.end, match.end);
        const span = textDivs[i];
        if (from >= to || !span || !span.firstChild || !span.isConnected) return;
        const range = document.createRange();
        range.setStart(span.firstChild, from - segment.start);
        range.setEnd(span.firstChild, to - segment.start);
        for (const rect of range.getClientRects()) {
          if (rect.width < 0.2 || rect.height < 0.2) continue;
          const mark = document.createElement("span");
          mark.className = "search-hit" + (doc.searchMatch?.key === match.key ? " current" : "");
          mark.dataset.matchKey = match.key;
          Object.assign(mark.style, {
            left: (rect.left - bounds.left) / bounds.width * 100 + "%",
            top: (rect.top - bounds.top) / bounds.height * 100 + "%",
            width: rect.width / bounds.width * 100 + "%", height: rect.height / bounds.height * 100 + "%",
          });
          layer.append(mark);
        }
      });
    }
  }

  function refresh(doc) {
    for (const surface of surfaces.values()) if (surface.doc === doc) draw(surface);
    finishJump();
  }

  function select(doc, match) {
    pendingJump = { doc, key: match.key };
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

  // The comparison view has no selectable text layer; create an invisible measuring layer on its original side only.
  async function mountOriginal(host, doc, page, viewport) {
    detach(host);
    const text = document.createElement("div"), layer = document.createElement("div");
    text.className = "pdf-text-layer search-text-layer"; text.setAttribute("aria-hidden", "true");
    text.style.setProperty("--scale-factor", viewport.scale);
    layer.className = "search-layer"; layer.setAttribute("aria-hidden", "true");
    host.append(text, layer);
    const surface = { host, doc, page: page.pageNumber - 1, layer, ownedText: text, textDivs: [] };
    surfaces.set(host, surface);
    try {
      const content = await page.getTextContent();
      if (surfaces.get(host) !== surface) return;
      surface.task = pdfjsLib.renderTextLayer({ textContentSource: content, container: text, viewport, textDivs: surface.textDivs, isOffscreenCanvasSupported: false });
      await surface.task.promise;
      if (surfaces.get(host) !== surface) return;
      surface.task = null; surface.index = buildSearchIndex(content);
      draw(surface); finishJump();
    } catch (error) {
      if (surfaces.get(host) === surface && error.name !== "AbortException") {
        console.error("Search text layer", error); toast("本页搜索高亮加载失败", 4000);
      }
    }
  }

  return { find, attach, detach, mountOriginal, refresh, select, cancelJump: () => { pendingJump = null; } };
})();
