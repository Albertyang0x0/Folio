/* PDF 文字选择与本地批注；不修改原文件，不使用翻译接口。 */
"use strict";

// Painting only: never shrink the native selection or the saved annotation anchors.
function selectionPaintRects(rects, pageHeight) {
  const painted = rects.map((r) => {
    const inset = (r[3] - r[1]) * 0.15;
    return [r[0], r[1] + inset, r[2], r[3] - inset];
  });
  for (let i = 0; i < rects.length; i++) {
    const a = rects[i], ay = (a[1] + a[3]) / 2;
    for (let j = i + 1; j < rects.length; j++) {
      const b = rects[j], by = (b[1] + b[3]) / 2;
      if (a[2] <= b[0] || b[2] <= a[0]) continue; // Separate columns.
      if (Math.abs(ay - by) < Math.max(a[3] - a[1], b[3] - b[1]) * 0.35) continue; // Same line, different font runs.
      const gap = Math.min(1 / pageHeight, Math.abs(ay - by) * 0.2), mid = (ay + by) / 2;
      const upper = painted[ay < by ? i : j], lower = painted[ay < by ? j : i];
      upper[3] = Math.min(upper[3], mid - gap / 2);
      lower[1] = Math.max(lower[1], mid + gap / 2);
    }
  }
  return painted.filter((r) => r[2] > r[0] && r[3] > r[1]);
}

const readerNotes = (() => {
  const keyPrefix = "paper-reader-notes-v1:";
  const documents = new Map(), surfaces = new Map();
  let api, pendingSelection = null, pendingJump = null, selectionFrame = 0, dragging = false, pointerStart = null;
  const el = (id) => document.getElementById(id);
  const enabled = () => api && api.getDoc() && api.getMode() !== "duo";
  const pageLabel = (note) => {
    const pages = note.anchors.map((a) => a.page + 1);
    return pages.length === 1 ? "第 " + pages[0] + " 页" : "第 " + pages[0] + "–" + pages[pages.length - 1] + " 页";
  };

  function validNote(note) {
    return note && typeof note.id === "string" && typeof note.quote === "string" && typeof note.body === "string" &&
      Array.isArray(note.anchors) && note.anchors.length > 0 && note.anchors.every((a) =>
        Number.isInteger(a.page) && a.page >= 0 && Array.isArray(a.rects) && a.rects.length > 0 && a.rects.every((r) =>
          Array.isArray(r) && r.length === 4 && r.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) && r[2] > r[0] && r[3] > r[1]));
  }

  function data(doc = api.getDoc()) {
    if (!doc) return null;
    if (!documents.has(doc.id)) {
      const value = { notes: [], marksVisible: true, panelOpen: false, activeId: null, writable: true, error: "", dirty: false };
      try {
        const raw = localStorage.getItem(keyPrefix + doc.id);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed.version !== 1 || !Array.isArray(parsed.notes) || !parsed.notes.every(validNote)) throw new Error("invalid notes");
          value.notes = parsed.notes;
          value.marksVisible = parsed.marksVisible !== false;
        }
      } catch (error) {
        value.writable = false;
        value.error = "无法读取本地笔记，原数据未覆盖。请先备份浏览器数据。";
        api.toast(value.error, 8000);
      }
      documents.set(doc.id, value);
    }
    return documents.get(doc.id);
  }

  function save(doc) {
    const value = data(doc);
    if (!value.writable) return false;
    try {
      localStorage.setItem(keyPrefix + doc.id, JSON.stringify({ version: 1, marksVisible: value.marksVisible, notes: value.notes }));
      value.dirty = false; value.error = "";
      return true;
    } catch (error) {
      value.dirty = true;
      if (!value.error) api.toast("笔记保存失败：浏览器存储不可用或已满。请先复制笔记内容备份。", 8000);
      value.error = "未保存，请复制内容备份";
      return false;
    }
  }

  function activeNote() {
    const value = data();
    return value && value.notes.find((note) => note.id === value.activeId);
  }

  function updateSaveStatus() {
    const value = data();
    el("noteSaveStatus").textContent = value && value.error ? value.error : "已保存到本地";
    el("noteSaveStatus").dataset.error = String(!!(value && value.error));
  }

  function renderList() {
    const value = data(), list = el("notesList");
    list.replaceChildren();
    if (!value || !value.notes.length) {
      const empty = document.createElement("p");
      empty.className = "empty-hint";
      empty.textContent = value && value.error ? value.error : "还没有笔记。拖动鼠标选中文字，再点击“添加笔记”。";
      list.append(empty);
      return;
    }
    for (const note of [...value.notes].sort((a, b) => a.anchors[0].page - b.anchors[0].page || a.createdAt - b.createdAt)) {
      const button = document.createElement("button");
      button.className = "note-list-item" + (note.id === value.activeId ? " active" : "");
      button.dataset.noteId = note.id;
      button.setAttribute("aria-current", note.id === value.activeId ? "true" : "false");
      for (const [className, text] of [["note-list-page", pageLabel(note)], ["note-list-quote", note.quote], ["note-list-body", note.body || "尚未填写笔记"]]) {
        const span = document.createElement("span"); span.className = className; span.textContent = text; button.append(span);
      }
      button.addEventListener("click", () => openNote(note.id, true));
      list.append(button);
    }
  }

  function sync() {
    const available = enabled(), value = data();
    el("noteControls").classList.toggle("hidden", !available);
    const open = !!(available && value.panelOpen);
    el("notesSidebar").classList.toggle("hidden", !open);
    el("btnNotes").setAttribute("aria-expanded", String(open));
    el("noteCount").textContent = value ? value.notes.length : 0;
    el("btnToggleMarks").textContent = value && !value.marksVisible ? "显示标记" : "隐藏标记";
    el("btnToggleMarks").setAttribute("aria-pressed", String(!!(value && value.marksVisible)));
    el("btnToggleMarks").disabled = !value || !value.notes.length;
    renderList();
    const note = activeNote();
    el("noteEditor").classList.toggle("hidden", !note);
    if (note) {
      el("noteQuote").textContent = note.quote;
      el("notePageLabel").textContent = pageLabel(note);
      el("noteBody").value = note.body;
      updateSaveStatus();
    }
    redrawMarks();
    if (!available) clearSelection();
  }

  function openNote(id, navigate = false) {
    if (!enabled()) return;
    const doc = api.getDoc(), value = data(doc), note = value.notes.find((n) => n.id === id);
    if (!note) return;
    value.activeId = id; value.panelOpen = true;
    sync();
    if (navigate) {
      pendingJump = { docId: doc.id, noteId: id };
      api.goToPage(note.anchors[0].page + 1);
      requestAnimationFrame(finishJump);
    }
  }

  function finishJump() {
    if (!pendingJump || !enabled() || api.getDoc().id !== pendingJump.docId) return;
    const note = data().notes.find((n) => n.id === pendingJump.noteId);
    if (!note) { pendingJump = null; return; }
    for (const surface of surfaces.values()) {
      if (surface.doc.id !== pendingJump.docId || surface.page !== note.anchors[0].page || !surface.host.getClientRects().length) continue;
      const rect = note.anchors[0].rects[0], host = surface.host.getBoundingClientRect();
      const scroller = surface.host.closest(".view"), view = scroller.getBoundingClientRect();
      scroller.scrollTop += host.top + ((rect[1] + rect[3]) / 2) * host.height - view.top - view.height / 2;
      scroller.scrollLeft += host.left + ((rect[0] + rect[2]) / 2) * host.width - view.left - view.width / 2;
      pendingJump = null;
      return;
    }
  }

  function drawMarks(surface) {
    const value = data(surface.doc), layer = surface.marks;
    layer.replaceChildren();
    layer.classList.toggle("hidden", !value.marksVisible);
    if (!value.marksVisible) return;
    for (const note of value.notes) {
      const anchor = note.anchors.find((a) => a.page === surface.page);
      if (!anchor) continue;
      anchor.rects.forEach((rect, index) => {
        const mark = document.createElement(index === 0 ? "button" : "span");
        mark.className = "annotation-rect" + (note.id === value.activeId ? " active" : "");
        mark.dataset.noteId = note.id;
        Object.assign(mark.style, { left: rect[0] * 100 + "%", top: rect[1] * 100 + "%", width: (rect[2] - rect[0]) * 100 + "%", height: (rect[3] - rect[1]) * 100 + "%" });
        if (index === 0) {
          mark.setAttribute("aria-label", "打开笔记：" + note.quote.slice(0, 100));
          mark.addEventListener("click", (event) => { event.stopPropagation(); openNote(note.id); });
        } else mark.setAttribute("aria-hidden", "true");
        layer.append(mark);
      });
    }
  }

  function redrawMarks() { for (const surface of surfaces.values()) drawMarks(surface); }

  function unmount(host) {
    readerSearch.detach(host);
    const surface = surfaces.get(host);
    if (!surface) return;
    surfaces.delete(host);
    if (surface.task) surface.task.cancel();
    surface.text.remove(); surface.marks.remove(); surface.selection.remove();
    delete host.dataset.textReady;
  }

  function clearContainer(container) {
    for (const host of [...surfaces.keys()]) if (container.contains(host)) unmount(host);
  }

  async function mount(host, doc, page, viewport) {
    unmount(host);
    const text = document.createElement("div"), marks = document.createElement("div"), selection = document.createElement("div");
    text.className = "pdf-text-layer"; text.style.setProperty("--scale-factor", viewport.scale);
    marks.className = "annotation-layer";
    selection.className = "selection-layer"; selection.setAttribute("aria-hidden", "true");
    host.classList.add("reader-page"); host.dataset.pageIndex = page.pageNumber - 1;
    host.append(marks, text, selection);
    const surface = { host, doc, page: page.pageNumber - 1, viewport, text, marks, selection, task: null };
    surfaces.set(host, surface);
    drawMarks(surface); finishJump();
    try {
      const content = await page.getTextContent();
      if (surfaces.get(host) !== surface || !host.isConnected) return;
      const textDivs = [];
      surface.task = pdfjsLib.renderTextLayer({ textContentSource: content, container: text, viewport, textDivs, isOffscreenCanvasSupported: false });
      await surface.task.promise;
      if (surfaces.get(host) !== surface) return;
      surface.task = null;
      readerSearch.attach(host, doc, page.pageNumber - 1, content, textDivs);
      host.dataset.textReady = "true";
      host.dataset.hasText = String(content.items.some((item) => item.str && item.str.trim()));
    } catch (error) {
      if (surfaces.get(host) === surface && error.name !== "AbortException") {
        host.dataset.textReady = "error";
        console.error("PDF text layer", error);
        api.toast("本页文字层加载失败，仍可阅读原页面。", 5000);
      }
    }
  }

  function hasSelectionWithin(host) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return false;
    for (let i = 0; i < selection.rangeCount; i++) {
      try { if (selection.getRangeAt(i).intersectsNode(host)) return true; } catch (error) { /* detached range */ }
    }
    return false;
  }

  function captureSelection() {
    if (!enabled()) return null;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const doc = api.getDoc(), anchors = [], fragments = [];
    const view = el(api.getMode() === "single" ? "singleView" : "continuousView").getBoundingClientRect();
    let endRect = null;
    for (const surface of surfaces.values()) {
      if (surface.doc !== doc || !surface.host.getClientRects().length) continue;
      const host = surface.host.getBoundingClientRect(), rects = [], strings = [];
      for (const span of surface.text.querySelectorAll("span")) {
        if (!span.firstChild || span.firstChild.nodeType !== Node.TEXT_NODE) continue;
        for (let i = 0; i < selection.rangeCount; i++) {
          const range = selection.getRangeAt(i);
          if (!range.intersectsNode(span)) continue;
          const part = document.createRange(); part.selectNodeContents(span);
          if (span.contains(range.startContainer)) part.setStart(range.startContainer, range.startOffset);
          if (span.contains(range.endContainer)) part.setEnd(range.endContainer, range.endOffset);
          const selected = part.toString();
          if (!selected) continue;
          strings.push(selected);
          for (const r of part.getClientRects()) {
            if (r.width < 0.2 || r.height < 0.2) continue;
            const clamp = (n) => Math.max(0, Math.min(1, n));
            const box = [clamp((r.left - host.left) / host.width), clamp((r.top - host.top) / host.height), clamp((r.right - host.left) / host.width), clamp((r.bottom - host.top) / host.height)];
            if (box[2] > box[0] && box[3] > box[1]) {
              rects.push(box);
              // Anchor the menu to visible text even when the selection extends off-screen.
              if (r.bottom >= view.top && r.top <= view.bottom && r.right >= view.left && r.left <= view.right) {
                endRect = { left: Math.max(r.left, view.left), bottom: Math.min(r.bottom, view.bottom) };
              }
            }
          }
        }
      }
      if (rects.length) { anchors.push({ page: surface.page, rects }); fragments.push(strings.join("")); }
    }
    if (!anchors.length) return null;
    anchors.sort((a, b) => a.page - b.page);
    // Native text selection retains PDF.js line breaks; only normalize extraction whitespace.
    const inTextLayer = (node) => (node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement))?.closest(".pdf-text-layer");
    if (!inTextLayer(selection.anchorNode) || !inTextLayer(selection.focusNode)) return null;
    const quote = (selection.toString() || fragments.join("\n")).replace(/\u00ad/g, "").replace(/-\s*\n\s*(?=[a-z])/g, "").replace(/\s+/g, " ").trim();
    return quote ? { docId: doc.id, anchors, quote, endRect } : null;
  }

  function drawSelection(selected) {
    for (const surface of surfaces.values()) {
      const anchor = selected && surface.doc.id === selected.docId && selected.anchors.find((a) => a.page === surface.page);
      const height = surface.host.getBoundingClientRect().height;
      const rects = anchor && height > 0 ? selectionPaintRects(anchor.rects, height) : [];
      if (!rects.length && !surface.selection.childElementCount) continue;
      const fragment = document.createDocumentFragment();
      for (const rect of rects) {
        const mark = document.createElement("span");
        mark.className = "selection-rect";
        Object.assign(mark.style, { left: rect[0] * 100 + "%", top: rect[1] * 100 + "%", width: (rect[2] - rect[0]) * 100 + "%", height: (rect[3] - rect[1]) * 100 + "%" });
        fragment.append(mark);
      }
      surface.selection.replaceChildren(fragment);
      // Keep the browser's native paint as fallback until our overlay is ready.
      surface.text.classList.toggle("has-custom-selection", rects.length > 0);
    }
  }

  function showSelection() {
    cancelAnimationFrame(selectionFrame);
    selectionFrame = requestAnimationFrame(() => {
      pendingSelection = captureSelection();
      drawSelection(pendingSelection);
      const toolbar = el("selectionToolbar");
      toolbar.classList.toggle("hidden", dragging || !pendingSelection);
      if (dragging || !pendingSelection) return;
      const rect = pendingSelection.endRect;
      if (!rect) {
        toolbar.classList.add("hidden");
        return;
      }
      const left = Math.max(8, Math.min(window.innerWidth - toolbar.offsetWidth - 8, rect.left));
      const top = Math.max(8, Math.min(window.innerHeight - toolbar.offsetHeight - 8, rect.bottom + 8));
      toolbar.style.left = left + "px"; toolbar.style.top = top + "px";
    });
  }

  function clearSelection() {
    cancelAnimationFrame(selectionFrame); pendingSelection = null;
    drawSelection(null);
    el("selectionToolbar").classList.add("hidden");
    const selection = window.getSelection();
    if (selection && selection.anchorNode && (selection.anchorNode.parentElement || selection.anchorNode).closest?.(".pdf-text-layer")) selection.removeAllRanges();
  }

  function addNote() {
    const selected = pendingSelection, doc = api.getDoc();
    if (!selected || !enabled() || selected.docId !== doc.id) return;
    const value = data(doc);
    if (!value.writable) { api.toast(value.error, 8000); return; }
    const now = Date.now(), note = { id: crypto.randomUUID(), quote: selected.quote, anchors: selected.anchors, body: "", createdAt: now, updatedAt: now };
    value.notes.push(note); value.marksVisible = true;
    save(doc); clearSelection(); openNote(note.id, true);
    el("noteBody").focus({ preventScroll: true });
  }

  function init(callbacks) {
    api = callbacks;
    el("btnNotes").addEventListener("click", () => {
      const value = data(); if (!value) return;
      value.panelOpen = !value.panelOpen;
      if (!value.activeId && value.notes.length) value.activeId = value.notes[0].id;
      clearSelection(); sync();
    });
    el("btnCloseNotes").addEventListener("click", () => { data().panelOpen = false; sync(); el("btnNotes").focus(); });
    el("btnToggleMarks").addEventListener("click", () => {
      const doc = api.getDoc(), value = data(doc); if (!value) return;
      value.marksVisible = !value.marksVisible; save(doc); sync();
    });
    el("noteBody").addEventListener("input", () => {
      const doc = api.getDoc(), note = activeNote(); if (!doc || !note) return;
      note.body = el("noteBody").value; note.updatedAt = Date.now();
      save(doc); updateSaveStatus(); renderList();
    });
    el("btnLocateNote").addEventListener("click", () => { const note = activeNote(); if (note) openNote(note.id, true); });
    el("btnDeleteNote").addEventListener("click", () => {
      const doc = api.getDoc(), value = data(doc), note = activeNote();
      if (!note || !confirm("删除这条批注？对应的文字标记和笔记内容将一起删除。")) return;
      value.notes = value.notes.filter((n) => n.id !== note.id);
      value.activeId = value.notes.length ? value.notes[0].id : null;
      save(doc); sync();
    });
    el("selectionToolbar").addEventListener("pointerdown", (event) => event.preventDefault());
    el("btnAddNote").addEventListener("click", addNote);
    el("btnCopySelection").addEventListener("click", async () => {
      const selected = pendingSelection; if (!selected) return;
      try { await navigator.clipboard.writeText(selected.quote); clearSelection(); api.toast("已复制选中文字", 1800); }
      catch (error) { api.toast("无法访问剪贴板，请按 Ctrl+C 复制选中文字。", 4000); }
    });
    document.addEventListener("copy", (event) => {
      const selected = captureSelection();
      if (selected && event.clipboardData) { event.clipboardData.setData("text/plain", selected.quote); event.preventDefault(); }
    });
    document.addEventListener("selectionchange", showSelection);
    document.addEventListener("pointerdown", (event) => {
      if (event.target.closest("#selectionToolbar")) return;
      dragging = !!event.target.closest(".pdf-text-layer");
      pointerStart = { x: event.clientX, y: event.clientY };
      el("selectionToolbar").classList.add("hidden");
    });
    document.addEventListener("pointerup", () => { dragging = false; showSelection(); });
    document.addEventListener("pointercancel", () => { dragging = false; showSelection(); });
    document.addEventListener("click", (event) => {
      if (!enabled() || !pointerStart || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4 || !window.getSelection().isCollapsed) return;
      const host = event.target.closest(".reader-page"), surface = surfaces.get(host), value = data();
      if (!surface || !value.marksVisible) return;
      const box = host.getBoundingClientRect(), x = (event.clientX - box.left) / box.width, y = (event.clientY - box.top) / box.height;
      const note = [...value.notes].reverse().find((n) => n.anchors.some((a) => a.page === surface.page && a.rects.some((r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3])));
      if (note) openNote(note.id);
    });
    document.addEventListener("scroll", () => { if (pendingSelection) showSelection(); }, true);
    window.addEventListener("resize", () => { if (pendingSelection) showSelection(); });
    window.addEventListener("beforeunload", (event) => {
      if ([...documents.values()].some((value) => value.dirty)) { event.preventDefault(); event.returnValue = ""; }
    });
  }

  return { init, sync, mount, unmount, clearContainer, clearSelection, hasSelectionWithin };
})();
