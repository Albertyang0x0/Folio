/* 阅屿 · Folio（阅读为主，翻译为辅助）；旧存储键保持不变以兼容历史数据。 */
"use strict";

const $ = (id) => document.getElementById(id);
const isMac = document.documentElement.dataset.platform === "macos";
const shortcutModifier = isMac ? "⌘" : "Ctrl";
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const LINE_ZH = 1.55; // 中文译文行距（倍字号）

/* ================= 全局状态 ================= */
const state = {
  tabs: [],          // 打开的文档标签
  active: -1,        // 当前标签下标
  mode: "continuous",// continuous | single | duo
  dpr: Math.max(1, window.devicePixelRatio || 1),
};

const DEFAULT_SETTINGS = {
  api_key: "",
  model: "deepseek-flash",
  base_url: "https://api.deepseek.com",
  target: "简体中文",
  translation_prompt: "",
  temperature: 0.3,
  prefetch: 0,
};

const cur = () => state.tabs[state.active];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= 工具 ================= */
function loadSettings() {
  try {
    const settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem("paper-reader-settings") || "{}"));
    if (typeof settings.translation_prompt !== "string") settings.translation_prompt = "";
    const base = (settings.base_url || DEFAULT_SETTINGS.base_url).trim().replace(/\/+$/, "").toLowerCase();
    if ((base === DEFAULT_SETTINGS.base_url || base === DEFAULT_SETTINGS.base_url + "/v1") &&
        ["deepseek-chat", "deepseek-reasoner"].includes(settings.model)) {
      settings.model = DEFAULT_SETTINGS.model;
    }
    return settings;
  }
  catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
}
function saveSettings(s) { localStorage.setItem("paper-reader-settings", JSON.stringify(s)); }

function translationCacheSettings() {
  const { base_url, model, target, translation_prompt } = loadSettings();
  return { base_url, model, target, translation_prompt };
}

let toastTimer = null;
function toast(msg, ms) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), ms || 4000);
  return toastTimer;
}

function dismissToast(timer) {
  if (timer !== toastTimer) return;
  clearTimeout(toastTimer);
  $("toast").classList.add("hidden");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function throttle(fn, ms) {
  let last = 0, t = null;
  return function (...args) {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn.apply(this, args); }
    else { clearTimeout(t); t = setTimeout(() => { last = Date.now(); fn.apply(this, args); }, ms); }
  };
}

/* ================= 沉浸阅读顶栏 ================= */
const ReaderChrome = (() => {
  function updateSearchPanelTop() {
    requestAnimationFrame(() => {
      const top = $('app').classList.contains('reader-chrome-collapsed')
        ? 10
        : $('topbar').getBoundingClientRect().bottom + 8;
      document.documentElement.style.setProperty('--search-panel-top', top + 'px');
    });
  }

  function setCollapsed(collapsed) {
    const app = $('app');
    if (app.classList.contains('reader-chrome-collapsed') === collapsed) return;
    if (collapsed && $('topbar').contains(document.activeElement)) document.activeElement.blur();
    app.classList.toggle('reader-chrome-collapsed', collapsed);
    $('topbar').inert = collapsed;
    $('topbar').setAttribute('aria-hidden', String(collapsed));
    const button = $('btnReaderChrome');
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', collapsed ? '显示顶部工具栏' : '隐藏顶部工具栏');
    button.title = collapsed ? '显示顶部工具栏' : '隐藏顶部工具栏';
    syncDockedNavigation();
    if (collapsed) button.focus({ preventScroll: true });
    updateSearchPanelTop();
    if (reduceMotion.matches) requestAnimationFrame(refreshVisiblePages);
  }

  function refreshVisiblePages() {
    if (state.mode === "continuous" && cur() && !$("app").classList.contains("hidden")) renderVisible();
  }

  function reveal() {
    setCollapsed(false);
  }

  function init() {
    $('btnReaderChrome').addEventListener('click', () => {
      const collapse = !$('app').classList.contains('reader-chrome-collapsed');
      if (collapse && !$('searchBox').classList.contains('hidden')) closeSearch();
      setCollapsed(collapse);
    });

    $('readerChrome').addEventListener('transitionend', (event) => {
      if (event.target === $('readerChrome') && event.propertyName === 'grid-template-rows') refreshVisiblePages();
    });
  }

  return { init, reveal };
})();

/* ================= 持久化 ================= */
function _loadJson(key) { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { return null; } }
function _saveJson(key, v) { localStorage.setItem(key, JSON.stringify(v)); }

function loadBookmarks(hash) { return (_loadJson("paper-reader-bookmarks") || {})[hash] || []; }
function saveBookmarks(hash, list) {
  const all = _loadJson("paper-reader-bookmarks") || {};
  all[hash] = list;
  _saveJson("paper-reader-bookmarks", all);
}

/* ================= 标签管理 ================= */
function newTab(id, name, pdfDoc, pagesMeta, outline, pdfData) {
  const tab = {
    id, name, pdfDoc, pagesMeta, outline: outline || [], pdfData,
    scale: null, duoScale: null, currentPage: 1, mode: "continuous", originalMode: "continuous", fitWidth: true,
    reading: PaperLibrary.get(id)?.reading || null, restoring: false, pendingRestore: null,
    duoOriginalScale: null, duoShowOriginal: true, duoSync: false,
    duoFitOriginal: true, duoFitTranslation: true, duoZoomTarget: "translation",
    translations: {}, translationErrors: {}, inFlight: new Set(), queue: [], translationChecked: new Set(),
    renderToken: 0,
    slots: null, thumbs: null,
    searchResults: [], searchIdx: -1, searchMatch: null, searchQuery: "", searchLoading: false, searchScope: "original",
  };
  state.tabs.push(tab);
  return tab;
}

function renderTabsBar() {
  const el = $("tabs");
  const restoreFocus = el.contains(document.activeElement);
  const fragment = document.createDocumentFragment();
  state.tabs.forEach((t, i) => {
    const tab = document.createElement("div");
    tab.className = "tab" + (i === state.active ? " active" : "");
    const name = document.createElement("button");
    name.type = "button";
    name.className = "tname";
    name.textContent = name.title = t.name;
    if (i === state.active) name.setAttribute("aria-current", "true");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "x";
    close.textContent = "×";
    close.title = "关闭 " + t.name;
    close.setAttribute("aria-label", close.title);
    name.addEventListener("click", () => activateTab(i));
    close.addEventListener("click", () => closeTab(i));
    tab.append(name, close);
    fragment.append(tab);
  });
  el.replaceChildren(fragment);
  const active = el.querySelector(".tab.active");
  if (active) {
    const tab = active.getBoundingClientRect();
    const strip = el.getBoundingClientRect();
    if (tab.right > strip.right) el.scrollLeft += tab.right - strip.right;
    else if (tab.left < strip.left) el.scrollLeft += tab.left - strip.left;
  }
  if (restoreFocus) (el.querySelector(".tab.active .tname") || $("btnLibraryAdd")).focus({ preventScroll: true });
}

async function activateTab(idx) {
  if (idx < 0 || idx >= state.tabs.length) return;
  if (idx === state.active && !$("app").classList.contains("hidden")) return;
  // 切换前保存当前进度
  if (state.active >= 0 && state.active !== idx) persistCurrentProgress();
  searchRun++;
  if (cur()) cur().searchLoading = false;
  readerSearch.cancelJump();
  readerNotes.unmount($("duoOrig").parentElement);
  duoPaint.original = null;
  cancelSingleRender();
  readerNotes.clearSelection();
  readerNotes.clearContainer($("pages"));
  readerNotes.unmount($("singlePage"));
  state.active = idx;
  const d = cur();
  const prog = d.reading || PaperLibrary.get(d.id)?.reading;
  d.restoring = true;
  d.lastReadActivity = Date.now();
  if (prog) {
    for (const key of ["mode", "originalMode", "scale", "fitWidth", "duoScale", "duoOriginalScale", "duoFitOriginal", "duoFitTranslation", "duoShowOriginal", "duoSync"]) {
      if (prog[key] !== undefined) d[key] = prog[key];
    }
  }
  $("searchInput").value = d.searchQuery;
  if (d.searchQuery) $("searchBox").classList.remove("hidden");
  else $("searchBox").classList.add("hidden");
  $("searchScope").value = d.searchScope;
  $("btnDocumentSearch").setAttribute("aria-expanded", String(!$("searchBox").classList.contains("hidden")));
  renderSearchPanel();
  ReaderChrome.reveal();
  setUploadHidden(true);
  $("app").classList.remove("hidden");
  if (d.fitWidth || d.scale == null) d.scale = fitWidthScale(d);
  renderTabsBar();
  buildSlots();
  buildThumbs();
  renderOutlinePanel();
  renderBookmarksPanel();
  updateZoomLabel();
  $("pageCount").textContent = d.pagesMeta.length;
  // 恢复进度
  const page = prog && prog.page ? Math.min(prog.page, d.pagesMeta.length) : 1;
  setCurrentLabel(page);
  d.pendingRestore = { ...(prog || {}), page, mode: d.mode };
  await applyMode(d.mode, true);
}

function closeTab(idx) {
  const d = state.tabs[idx];
  if (!d) return;
  persistCurrentProgress();
  PaperLibrary.flush();
  const wasActive = idx === state.active;
  if (singleRenderJob && singleRenderJob.doc === d) cancelSingleRender();
  if (duoRenderJob && duoRenderJob.doc === d) cancelDuoRender();
  for (const side of ["original", "translation"]) {
    if (duoPaint[side] && duoPaint[side].doc === d) duoPaint[side] = null;
  }
  try { d.pdfDoc.destroy(); } catch (e) {}
  state.tabs.splice(idx, 1);
  if (!state.tabs.length) {
    searchRun++;
    readerSearch.cancelJump();
    readerNotes.unmount($("duoOrig").parentElement);
    state.active = -1;
    $("app").classList.add("hidden");
    setUploadHidden(false);
    renderTabsBar();
    readerNotes.clearSelection();
    readerNotes.clearContainer($("pages"));
    readerNotes.unmount($("singlePage"));
    readerNotes.sync();
    return;
  }
  if (!wasActive) {
    if (idx < state.active) state.active--;
    renderTabsBar();
    return;
  }
  state.active = -1;
  activateTab(Math.min(idx, state.tabs.length - 1));
}

function persistCurrentProgress() {
  const d = cur();
  if (!d || d.restoring || $("app").classList.contains("hidden")) return;
  const reading = { ...(d.reading || {}), page: d.currentPage, mode: state.mode, originalMode: d.originalMode };
  delete reading.legacyScrollTop;
  for (const key of ["scale", "duoScale", "duoOriginalScale"]) reading[key] = d[key] || 1;
  for (const key of ["fitWidth", "duoFitOriginal", "duoFitTranslation", "duoShowOriginal", "duoSync"]) reading[key] = d[key];
  const meta = d.pagesMeta[d.currentPage - 1];
  const anchor = (id, scale) => ({ x: $(id).scrollLeft / (meta.width * scale), y: $(id).scrollTop / (meta.height * scale) });
  if (state.mode === "continuous") {
    const view = $("continuousView"), index = currentTopSlot(view.scrollTop), slot = d.slots[index];
    if (slot) reading.continuous = { page: index + 1, x: view.scrollLeft / slot.cssW, y: (view.scrollTop - slot.top) / slot.cssH };
  } else if (state.mode === "single") reading.single = anchor("singleView", d.scale);
  else {
    if (d.duoShowOriginal) reading.original = anchor("duoOriginalScroll", d.duoOriginalScale);
    reading.translation = d.lateTranslationAnchor?.anchor || anchor("duoTranslationScroll", d.duoScale);
  }
  d.reading = reading; d.mode = state.mode;
  PaperLibrary.save(d, reading, d.lastReadActivity);
}

function restoreReadingPosition(d, side) {
  if (cur() !== d) return;
  const saved = d.pendingRestore;
  if (!saved || saved.mode !== state.mode || saved.page !== d.currentPage) return;
  const meta = d.pagesMeta[d.currentPage - 1];
  const place = (id, anchor, scale) => {
    $(id).scrollLeft = Math.max(0, (anchor?.x || 0) * meta.width * scale);
    $(id).scrollTop = Math.max(0, (anchor?.y || 0) * meta.height * scale);
  };
  if (state.mode === "continuous") {
    const anchor = saved.continuous;
    if (anchor) {
      const slot = d.slots[Math.max(0, Math.min(d.slots.length - 1, anchor.page - 1))];
      $("continuousView").scrollTop = slot.top + anchor.y * slot.cssH;
      $("continuousView").scrollLeft = anchor.x * slot.cssW;
    } else if (saved.legacyScrollTop) $("continuousView").scrollTop = saved.legacyScrollTop;
    else scrollToPage(saved.page);
    renderVisible();
  } else if (state.mode === "single") place("singleView", saved.single, d.scale);
  else {
    const original = side === "original";
    place(original ? "duoOriginalScroll" : "duoTranslationScroll", saved[side], original ? d.duoOriginalScale : d.duoScale);
    if (original) return; // Translation is published last (also when original is hidden).
    if (!d.duoShowOriginal && saved.original) d.hiddenOriginalAnchor = { page: d.currentPage, anchor: saved.original };
    if (!d.translations[d.currentPage - 1] && saved.translation) d.lateTranslationAnchor = { page: d.currentPage, anchor: saved.translation };
  }
  d.pendingRestore = null;
  requestAnimationFrame(() => {
    if (cur() !== d || d.pendingRestore) return;
    d.restoring = false;
    persistCurrentProgress();
  });
}

function showLibrary() {
  persistCurrentProgress(); PaperLibrary.flush();
  ReaderChrome.reveal();
  readerNotes.clearSelection();
  readerSearch.cancelJump();
  $("searchPanel").classList.add("hidden");
  $("app").classList.add("hidden");
  setUploadHidden(false);
}

/* ================= 文件打开 ================= */
function setUploadHidden(hidden) {
  $("uploadScreen").classList.toggle("hidden", hidden);
  if (!hidden) PaperLibrary.show();
}

function fitWidthScale(d) {
  const meta = d.pagesMeta[0];
  if (!meta) return 1;
  const avail = Math.max(420, $("viewer").clientWidth - 80);
  return Math.max(0.3, Math.min(3, avail / meta.width));
}

async function handleFile(file) {
  if (!file) return;
  if (openingDocument) return;
  if (!/\.pdf$/i.test(file.name)) { toast("请选择 PDF 文件"); return; }
  persistCurrentProgress(); PaperLibrary.flush();
  openingDocument = true;
  setUploadHidden(true);
  const progressToast = toast("正在解析 PDF…", 2500);
  try {
    const data = await importPDF(file);
    const existing = state.tabs.findIndex((tab) => tab.id === data.pdf_hash);
    if (existing >= 0) { await activateTab(existing); return; }
    const pdfData = await file.arrayBuffer();
    pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
    const pdfDoc = await pdfjsLib.getDocument({ data: pdfData }).promise;
    const tab = newTab(data.pdf_hash, data.file_name || file.name, pdfDoc, data.pages, data.outline, pdfData);
    await activateTab(state.tabs.length - 1);
    const withBlocks = tab.pagesMeta.filter((p) => p.blocks.length).length;
    if (!withBlocks) toast("未检测到文字层：扫描版无法翻译，但可正常阅读", 6000);
  } catch (e) {
    console.error(e);
    toast("解析失败：" + e.message, 6000);
    setUploadHidden(false);
  } finally {
    dismissToast(progressToast);
    openingDocument = false;
  }
}

async function importPDF(file) {
  if (!/\.pdf$/i.test(file.name)) throw new Error("请选择 PDF 文件");
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/parse", { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || ("解析失败 " + res.status));
  PaperLibrary.register(data, data.pdf_hash, data.file_name || file.name, data.pages.length);
  return data;
}

async function handleFiles(files) {
  const selected = Array.from(files);
  if (selected.length < 2) return handleFile(selected[0]);
  if (openingDocument) return;
  openingDocument = true;
  showLibrary();
  const failed = [];
  try {
    for (let i = 0; i < selected.length; i++) {
      const file = selected[i];
      toast(`正在导入 ${i + 1}/${selected.length} · ${file.name}`);
      try {
        await importPDF(file);
      } catch (error) {
        failed.push(`${file.name}（${error.message}）`);
      }
    }
    PaperLibrary.render();
    const message = `已导入 ${selected.length - failed.length} 份 PDF`;
    toast(failed.length ? `${message}，${failed.length} 份失败。 ${failed.slice(0, 2).join("、")}` : message, failed.length ? 9000 : 4000);
  } finally {
    openingDocument = false;
  }
}

let openingDocument = false;
async function reopenDoc(hash) {
  if (openingDocument) return;
  const existing = state.tabs.findIndex((tab) => tab.id === hash);
  if (existing >= 0) return activateTab(existing);
  openingDocument = true;
  setUploadHidden(true);
  const progressToast = toast("正在打开…", 2500);
  try {
    const metaRes = await fetch("/api/doc/" + encodeURIComponent(hash));
    if (!metaRes.ok) throw new Error("文档信息不存在，请重新上传");
    const meta = await metaRes.json();
    const pdfRes = await fetch("/api/reopen/" + encodeURIComponent(hash));
    if (!pdfRes.ok) throw new Error("原文件已不存在，请重新上传");
    const pdfData = await pdfRes.arrayBuffer();
    pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
    const pdfDoc = await pdfjsLib.getDocument({ data: pdfData }).promise;
    PaperLibrary.register(meta, hash, meta.file_name || "document.pdf", meta.pages.length);
    const tab = newTab(hash, meta.file_name || "document.pdf", pdfDoc, meta.pages, meta.outline, pdfData);
    await activateTab(state.tabs.length - 1);
  } catch (e) {
    console.error(e);
    toast("打开失败：" + e.message, 6000);
    setUploadHidden(false);
  } finally {
    dismissToast(progressToast);
    openingDocument = false;
  }
}

/* ================= 连续滚动渲染（虚拟化） ================= */
const PAGE_GAP = 22;
const PAGE_PAD = 18;

function buildSlots() {
  const d = cur(); if (!d) return;
  const container = $("pages");
  readerNotes.clearContainer(container);
  for (const slot of d.slots || []) if (slot.renderTask) slot.renderTask.cancel();
  container.innerHTML = "";
  d.slots = [];
  let y = PAGE_PAD;
  for (let i = 0; i < d.pagesMeta.length; i++) {
    const meta = d.pagesMeta[i];
    const cssW = Math.round(meta.width * d.scale);
    const cssH = Math.round(meta.height * d.scale);
    const slot = document.createElement("div");
    slot.className = "page-slot reader-page";
    slot.style.top = y + "px";
    slot.style.width = cssW + "px";
    slot.style.height = cssH + "px";
    const cv = document.createElement("canvas");
    cv.className = "page-canvas";
    cv.style.width = cssW + "px";
    cv.style.height = cssH + "px";
    slot.appendChild(cv);
    const pn = document.createElement("div");
    pn.className = "pnum"; pn.textContent = (i + 1);
    slot.appendChild(pn);
    container.appendChild(slot);
    d.slots.push({ doc: d, el: slot, canvas: cv, top: y, cssW, cssH, rendered: false, rendering: false, renderTask: null, idx: i });
    y += cssH + PAGE_GAP;
  }
  container.style.height = (y + 80) + "px";
  container.style.width = (Math.max(0, ...d.slots.map((s) => s.cssW)) + 32) + "px";
}

async function renderSlot(s) {
  const d = s.doc; if (!d || cur() !== d) return;
  if (s.rendered || s.rendering) return;
  s.rendering = true;
  const token = d.renderToken;
  try {
    const page = await d.pdfDoc.getPage(s.idx + 1);
    if (token !== d.renderToken || cur() !== d || !s.el.isConnected) return;
    const vp = page.getViewport({ scale: d.scale * state.dpr });
    const cw = Math.ceil(vp.width), ch = Math.ceil(vp.height);
    s.canvas.width = cw; s.canvas.height = ch;
    s.canvas.style.width = Math.ceil(cw / state.dpr) + "px";
    s.canvas.style.height = Math.ceil(ch / state.dpr) + "px";
    s.el.style.width = s.canvas.style.width;
    s.el.style.height = s.canvas.style.height;
    s.renderTask = page.render({ canvasContext: s.canvas.getContext("2d"), viewport: vp });
    await s.renderTask.promise;
    if (token !== d.renderToken || cur() !== d || !s.el.isConnected) return;
    await readerNotes.mount(s.el, d, page, page.getViewport({ scale: d.scale }));
    s.rendered = true;
  } catch (e) {
    if (e.name !== "RenderingCancelledException") console.error("render slot", s.idx, e);
  } finally {
    s.renderTask = null;
    s.rendering = false;
  }
}

function releaseSlot(s) {
  if (s.rendering) return;
  if (!s.rendered) return;
  if (readerNotes.hasSelectionWithin(s.el)) return;
  readerNotes.unmount(s.el);
  s.rendered = false;
  s.canvas.width = 0; s.canvas.height = 0;
}

function renderVisible() {
  const d = cur(); if (!d || !d.slots) return;
  const view = $("continuousView");
  const st = view.scrollTop, vh = view.clientHeight;
  const buf = vh * 1.2;
  const lo = st - buf, hi = st + vh + buf;
  for (const s of d.slots) {
    const bot = s.top + s.cssH;
    if (bot >= lo && s.top <= hi) {
      if (!s.rendered && !s.rendering) renderSlot(s);
    } else if (s.top > hi + vh || bot < lo - vh) {
      releaseSlot(s);
    }
  }
}

function scrollToPage(n) {
  const d = cur(); if (!d || !d.slots) return;
  const s = d.slots[n - 1];
  if (s) $("continuousView").scrollTop = s.top - 8;
}

function currentTopSlot(scrollTop) {
  const d = cur(); if (!d || !d.slots) return 0;
  let best = 0;
  for (let i = 0; i < d.slots.length; i++) if (d.slots[i].top <= scrollTop + 1) best = i;
  return best;
}

function updateCurrentFromScroll() {
  const d = cur(); if (!d || !d.slots || state.mode !== "continuous") return;
  const view = $("continuousView");
  const best = currentTopSlot(view.scrollTop + view.clientHeight * 0.4);
  if (best + 1 !== d.currentPage) setCurrentLabel(best + 1);
}

/* ================= 单页渲染 ================= */
let singleRenderJob = null;

function cancelSingleRender() {
  if (singleRenderJob && singleRenderJob.task) singleRenderJob.task.cancel();
  singleRenderJob = null;
}

async function renderSingle() {
  const d = cur(); if (!d || state.mode !== "single") return;
  cancelSingleRender();
  readerNotes.unmount($("singlePage"));
  const idx = d.currentPage - 1;
  const token = ++d.renderToken;
  const job = { doc: d, task: null };
  singleRenderJob = job;
  const buffer = document.createElement("canvas");
  const active = () => singleRenderJob === job && cur() === d && state.mode === "single" && token === d.renderToken;
  try {
    const page = await d.pdfDoc.getPage(idx + 1);
    if (!active()) return;
    const vp = page.getViewport({ scale: d.scale * state.dpr });
    buffer.width = Math.ceil(vp.width); buffer.height = Math.ceil(vp.height);
    job.task = page.render({ canvasContext: buffer.getContext("2d"), viewport: vp });
    await job.task.promise;
    job.task = null;
    if (!active()) return;
    const cv = $("singleCanvas"), host = $("singlePage");
    const changedPage = host.dataset.pageIndex !== String(idx) || host.dataset.docId !== d.id;
    cv.width = buffer.width; cv.height = buffer.height;
    cv.style.width = Math.ceil(vp.width / state.dpr) + "px";
    cv.style.height = Math.ceil(vp.height / state.dpr) + "px";
    host.style.width = cv.style.width; host.style.height = cv.style.height; host.dataset.docId = d.id;
    cv.getContext("2d").drawImage(buffer, 0, 0);
    if (changedPage) $("singleView").scrollTo(0, 0);
    await readerNotes.mount(host, d, page, page.getViewport({ scale: d.scale }));
    restoreReadingPosition(d);
  } catch (e) {
    if (active() && e.name !== "RenderingCancelledException") { console.error(e); toast("页面绘制出错：" + e.message, 5000); }
  } finally {
    buffer.width = 0; buffer.height = 0;
    if (singleRenderJob === job) singleRenderJob = null;
  }
}

/* ================= 对照（沉浸翻译）渲染 ================= */
let duoRenderJob = null;
let duoVisibilityTransition = null;
const duoPaint = { original: null, translation: null };
const duoProgrammaticScroll = new WeakMap();
const duoScroller = (side) => $(side === "original" ? "duoOriginalScroll" : "duoTranslationScroll");

function duoReadingAnchor(scroller, blocks) {
  const view = scroller.getBoundingClientRect();
  const page = scroller.querySelector(".duo-page").getBoundingClientRect();
  const guide = view.top + Math.min(72, view.height * .2) - page.top;
  const x = view.left + view.width / 2 - page.left;
  let closest = null, closestDistance = Infinity;
  for (const block of blocks?.values() || []) {
    const vertical = Math.max(0, block.top - guide, guide - block.bottom);
    const horizontal = Math.max(0, block.left - x, x - block.right);
    const distance = vertical + horizontal * .12;
    if (distance < closestDistance) {
      closest = block;
      closestDistance = distance;
    }
  }
  if (!closest) return null;
  return { id: closest.id, offset: (guide - closest.top) / Math.max(1, closest.bottom - closest.top) };
}

function restoreDuoAnchor(scroller, block, offset) {
  const view = scroller.getBoundingClientRect();
  const page = scroller.querySelector(".duo-page").getBoundingClientRect();
  const target = block.top + offset * (block.bottom - block.top);
  scroller.scrollTop += page.top - view.top + target - Math.min(72, view.height * .2);
  duoProgrammaticScroll.set(scroller, scroller.scrollTop);
}

function syncDuoScroll(side, fromEvent = false) {
  const d = cur(), scroller = duoScroller(side);
  if (fromEvent && duoProgrammaticScroll.get(scroller) === scroller.scrollTop) {
    duoProgrammaticScroll.delete(scroller);
    return;
  }
  if (!d?.duoSync || !d.duoShowOriginal || d.restoring || state.mode !== "duo" || duoVisibilityTransition) return;
  const other = side === "original" ? "translation" : "original";
  const from = duoPaint[side], to = duoPaint[other], page = d.currentPage - 1;
  if (from?.doc !== d || to?.doc !== d || from.page !== page || to.page !== page) return;
  // Restrict the guide to blocks drawn in both panes, including partial translations.
  const comparable = new Map([...from.blocks].filter(([id]) => to.blocks.has(id)));
  const anchor = duoReadingAnchor(scroller, comparable);
  if (anchor) restoreDuoAnchor(duoScroller(other), to.blocks.get(anchor.id), Math.max(-.25, Math.min(1.25, anchor.offset)));
}

function cancelDuoRender() {
  if (!duoRenderJob) return;
  for (const task of duoRenderJob.tasks) task.cancel();
  duoRenderJob = null;
}

function sameDuoPaint(a, b) {
  return a && a.doc === b.doc && a.page === b.page && a.scale === b.scale &&
    a.dpr === b.dpr && a.revision === b.revision;
}

function hasTranslatableBlocks(page) {
  return page.blocks.some((block) => !block.math && !block.skip);
}

function publishDuoCanvas(side, source, vp, info, draw) {
  const original = side === "original";
  const canvas = $(original ? "duoOrig" : "duoTrans");
  const scroller = duoScroller(side);
  const previous = duoPaint[side];
  const samePage = previous && previous.doc === info.doc && previous.page === info.page;
  const anchor = samePage && scroller.scrollTop > 0 ? duoReadingAnchor(scroller, previous.blocks) : null;
  const ratio = samePage ? info.scale / previous.scale : 1;
  const left = samePage && scroller.scrollLeft > 0 ? (scroller.scrollLeft + scroller.clientWidth / 2) * ratio - scroller.clientWidth / 2 : 0;
  const top = samePage && scroller.scrollTop > 0 ? (scroller.scrollTop + scroller.clientHeight / 2) * ratio - scroller.clientHeight / 2 : 0;
  canvas.width = source.width; canvas.height = source.height;
  canvas.style.width = Math.ceil(vp.width / info.dpr) + "px";
  canvas.style.height = Math.ceil(vp.height / info.dpr) + "px";
  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, 0, 0);
  info.blocks = draw(ctx);
  scroller.scrollLeft = left;
  scroller.scrollTop = top;
  if (anchor && info.blocks.has(anchor.id) && !info.doc.pendingRestore) {
    restoreDuoAnchor(scroller, info.blocks.get(anchor.id), anchor.offset);
  }
  canvas.dataset.pageNumber = info.page + 1;
  duoPaint[side] = info;
  restoreReadingPosition(info.doc, side);
  const hiddenOriginal = info.doc.hiddenOriginalAnchor;
  if (side === "original" && hiddenOriginal && hiddenOriginal.page === info.page + 1) {
    const meta = info.doc.pagesMeta[info.page];
    scroller.scrollTop = hiddenOriginal.anchor.y * meta.height * info.scale;
    scroller.scrollLeft = hiddenOriginal.anchor.x * meta.width * info.scale;
    info.doc.hiddenOriginalAnchor = null;
  }
  const late = info.doc.lateTranslationAnchor;
  if (side === "translation" && late && late.page === info.page + 1 && info.doc.translations[info.page]) {
    const meta = info.doc.pagesMeta[info.page];
    scroller.scrollTop = late.anchor.y * meta.height * info.scale;
    scroller.scrollLeft = late.anchor.x * meta.width * info.scale;
    info.doc.lateTranslationAnchor = null;
  }
  duoProgrammaticScroll.set(scroller, scroller.scrollTop);
}

async function renderDuo() {
  let d = cur(); if (!d || state.mode !== "duo" || $("app").classList.contains("hidden")) return;
  if (duoVisibilityTransition) await duoVisibilityTransition;
  d = cur(); if (!d || state.mode !== "duo" || $("app").classList.contains("hidden")) return;
  syncDuoControls(d);
  readerSearch.refresh(d);
  cancelDuoRender();
  const idx = d.currentPage - 1;
  const meta = d.pagesMeta[idx];
  const translatable = hasTranslatableBlocks(meta);
  const tr = d.translations[idx];
  updateTranslationNotice(d);
  const original = { doc: d, page: idx, scale: d.duoOriginalScale, dpr: state.dpr,
    revision: null };
  const translated = { doc: d, page: idx, scale: d.duoScale, dpr: state.dpr,
    revision: tr || null };
  const needOriginal = d.duoShowOriginal && (!!d.pendingRestore || !!d.hiddenOriginalAnchor || !sameDuoPaint(duoPaint.original, original));
  const needTranslation = !!d.pendingRestore || !sameDuoPaint(duoPaint.translation, translated);
  if (!needOriginal && !needTranslation) return;
  const token = ++d.renderToken;
  const job = { doc: d, tasks: new Set() };
  duoRenderJob = job;
  const active = () => duoRenderJob === job && cur() === d && state.mode === "duo" && token === d.renderToken;
  const buffers = [];
  try {
    const page = await d.pdfDoc.getPage(idx + 1);
    if (!active()) return;
    // 每次渲染只在离屏画布上运行 PDF.js，快速缩放时取消旧任务，不争用可见画布。
    const raster = async (scale) => {
      const vp = page.getViewport({ scale: scale * state.dpr });
      const canvas = document.createElement("canvas");
      buffers.push(canvas);
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      const task = page.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
      job.tasks.add(task);
      try { await task.promise; } finally { job.tasks.delete(task); }
      return { canvas, vp };
    };
    let source = null;
    if (needOriginal) {
      source = await raster(original.scale);
      if (!active()) return;
      publishDuoCanvas("original", source.canvas, source.vp, original, () => {
        const blocks = new Map();
        for (const block of meta.blocks) {
          const r = toViewportRect(block.bbox, source.vp, meta);
          const { dpr } = original;
          blocks.set(block.id, { id: block.id, left: r.x / dpr, right: (r.x + r.w) / dpr,
            top: r.y / dpr, bottom: (r.y + r.h) / dpr });
        }
        return blocks;
      });
      await readerNotes.mount($("duoOrig").parentElement, d, page, page.getViewport({ scale: original.scale }));
      if (!active()) return;
    }
    if (needTranslation) {
      // 公式/图表裁取始终使用译文倍率的原始 PDF，不依赖左侧是否显示或左侧倍率。
      if (!source || original.scale !== translated.scale) source = await raster(translated.scale);
      if (!active()) return;
      const host = $("duoTrans").parentElement;
      readerSearch.detach(host);
      const textLayer = $("duoTranslationText");
      textLayer.replaceChildren();
      publishDuoCanvas("translation", source.canvas, source.vp, translated, (ctx) => {
        if (tr) {
          const text = {};
          tr.blocks.forEach((b) => { text[b.id] = b.rich_text ?? b.text; });
          if (tr.complete === false) {
            for (const block of meta.blocks) {
              if (!block.skip && !block.math && text[block.id] === undefined) {
                text[block.id] = block.translation_text ?? block.text;
              }
            }
          }
          const layout = reflowPage(ctx, source.canvas, meta, text, source.vp, translated.scale, state.dpr);
          readerSearch.attachTranslation(host, d, idx, textLayer, layout, tr.blocks);
          return layout;
        }
        if (translatable) {
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        }
        return new Map();
      });
      if (d.duoSync && !d.pendingRestore && !d.searchMatch) syncDuoScroll(d.duoZoomTarget);
      readerSearch.refresh(d);
    }
  } catch (e) {
    if (active() && e.name !== "RenderingCancelledException") {
      console.error(e);
      toast("对照页面绘制出错：" + e.message, 6000);
    }
  } finally {
    for (const canvas of buffers) { canvas.width = 0; canvas.height = 0; }
    if (duoRenderJob === job) duoRenderJob = null;
  }
}

/* ================= 译文绘制（复用已验证逻辑） ================= */
function toViewportRect(bbox, vp, meta) {
  const H = meta.height;
  const p0 = vp.convertToViewportPoint(bbox[0], H - bbox[1]);
  const p1 = vp.convertToViewportPoint(bbox[2], H - bbox[3]);
  return {
    x: Math.min(p0[0], p1[0]),
    y: Math.min(p0[1], p1[1]),
    w: Math.abs(p1[0] - p0[0]),
    h: Math.abs(p1[1] - p0[1]),
  };
}

function sampleBg(ctx, r) {
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  const spots = [
    [r.x + r.w * 0.15, r.y - 2], [r.x + r.w * 0.5, r.y - 2], [r.x + r.w * 0.85, r.y - 2],
    [r.x + r.w * 0.15, r.y + r.h + 2], [r.x + r.w * 0.5, r.y + r.h + 2], [r.x + r.w * 0.85, r.y + r.h + 2],
    [r.x - 2, r.y + r.h * 0.25], [r.x + r.w + 2, r.y + r.h * 0.25],
    [r.x - 2, r.y + r.h * 0.5], [r.x + r.w + 2, r.y + r.h * 0.5],
    [r.x - 2, r.y + r.h * 0.75], [r.x + r.w + 2, r.y + r.h * 0.75],
  ];
  const rs = [], gs = [], bs = [];
  for (const sp of spots) {
    const x = Math.min(cw - 1, Math.max(0, Math.round(sp[0])));
    const y = Math.min(ch - 1, Math.max(0, Math.round(sp[1])));
    const dd = ctx.getImageData(x, y, 1, 1).data;
    rs.push(dd[0]); gs.push(dd[1]); bs.push(dd[2]);
  }
  const med = (a) => a.slice().sort((p, q) => p - q)[Math.floor(a.length / 2)];
  return "rgb(" + med(rs) + "," + med(gs) + "," + med(bs) + ")";
}

function computeBodyFs(meta) {
  const sizes = meta.blocks
    .filter((b) => !b.math && !b.skip && b.font_size >= 8 && b.font_size < 20)
    .map((b) => b.font_size).sort((a, b) => a - b);
  return sizes.length ? sizes[Math.floor(sizes.length / 2)] : 10;
}

function textLayoutUnits(text, ctx, maxW) {
  // 英文姓名、年份和文本公式整体换行；中文按字换行。标点跟随前面的单元，
  // 左括号跟随后面的单元，避免 2025b / LLM / Bevendorff 被任意劈开。
  const atoms = String(text).match(/[（(【\[]?(?:[A-Za-z]_(?:\{[^{}\n]{1,40}\}|[A-Za-z0-9]+)(?:\^(?:\{[^{}\n]{1,40}\}|[A-Za-z0-9]+))?|[α-ωΑ-Ω](?:_(?:\{[^{}\n]{1,40}\}|[A-Za-z0-9]+))?(?:\^(?:\{[^{}\n]{1,40}\}|[A-Za-z0-9]+))?|[A-Za-z\u00c0-\u024f]+(?:['’\-][A-Za-z\u00c0-\u024f]+)*|\d+(?:[.,]\d+)*[a-z]?|[^\s])[，。、；：！？,.!?;:%）)】\]]*|\n|[^\S\n]+/gu) || [];
  return atoms.flatMap((atom) => {
    // 只有单个词本身超过整栏宽度时才紧急拆分；不要因首行缩进而拆词。
    if (!/[_^α-ωΑ-Ω]/.test(atom) && ctx.measureText(atom).width > maxW) return Array.from(atom);
    return [atom];
  });
}

function wrapText(ctx, text, fs, maxW, firstIndent) {
  const lines = [];
  let cur = "";
  let effectiveIndent = firstIndent || 0;
  let limit = maxW - effectiveIndent;
  const units = textLayoutUnits(text, ctx, maxW);
  for (const unit of units) {
    if (unit === "\n") { lines.push(cur.trimEnd()); cur = ""; limit = maxW; continue; }
    if (!cur && !unit.trim()) continue;
    if (!cur && !lines.length && ctx.measureText(unit).width > limit) {
      effectiveIndent = 0; limit = maxW;
    }
    const trial = cur + unit;
    if (ctx.measureText(trial).width > limit && cur && unit.trim()) {
      lines.push(cur.trimEnd());
      cur = unit;
      limit = maxW;
    } else {
      cur = trial;
    }
  }
  lines.push(cur.trimEnd());
  lines.firstIndent = effectiveIndent;
  return lines;
}

// 文字、局部样式和公式共享行盒。样式标记不占宽度；公式有真实宽度、
// 基线上方高度和基线下方高度。原图只在绘制时裁取。
function layoutInlineText(ctx, text, block, fs, maxW, firstIndent, meta, vp) {
  const formulas = new Map((block.inline_math || []).map((m) => [m.token, m]));
  const styles = new Map((block.inline_styles || []).map((s) => [s.token, s]));
  const units = [];
  const tokenRe = /__MATH_\d{4,}__|__STYLE_(\d{4,})_(OPEN|CLOSE)__/g;
  const baseFont = ctx.font;
  const family = String(baseFont).replace(/^.*?[\d.]+px\s+/, "") || "sans-serif";
  const hasLocalStyles = styles.size > 0;
  let activeStyle = { bold: hasLocalStyles ? false : !!block.bold,
    italic: hasLocalStyles ? false : !!block.italic };
  const styleStack = [];
  const fontFor = (style) => (style.bold ? "bold " : "") + (style.italic ? "italic " : "") + fs + "px " + family;
  const setFont = (style) => { ctx.font = fontFor(style); };
  let pos = 0, match;
  const pushText = (value) => {
    setFont(activeStyle);
    for (const atom of textLayoutUnits(value, ctx, maxW)) {
      units.push({ type: "text", text: atom, bold: activeStyle.bold,
        italic: activeStyle.italic, font: ctx.font });
    }
  };
  while ((match = tokenRe.exec(String(text))) !== null) {
    pushText(String(text).slice(pos, match.index));
    if (match[1]) {
      const key = "__STYLE_" + match[1] + "__";
      if (match[2] === "OPEN") {
        const next = styles.get(key);
        if (!next) {
          ctx.font = baseFont;
          throw new Error("局部样式信息缺失，请重新打开文档后重试：" + key);
        }
        styleStack.push(activeStyle);
        activeStyle = { bold: !!next.bold, italic: !!next.italic };
      } else {
        activeStyle = styleStack.pop() || { bold: false, italic: false };
      }
      pos = match.index + match[0].length;
      continue;
    }
    const m = formulas.get(match[0]);
    if (!m || !m.bbox || !(m.font_size > 0)) {
      ctx.font = baseFont;
      throw new Error("内联公式坐标缺失，请重新打开文档后重试：" + match[0]);
    }
    const padding = fs * 0.08;
    let imageW = 0, ascent = 0, descent = 0;
    const slices = [];
    for (const part of (m.parts || [m])) {
      if (imageW > 0) imageW += fs * 0.16;
      const ratio = fs / part.font_size;
      ascent = Math.max(ascent, (part.baseline - part.bbox[1]) * ratio);
      descent = Math.max(descent, (part.bbox[3] - part.baseline) * ratio);
      for (const clip of (part.clips || [part.bbox])) {
        slices.push({ crop: toViewportRect(clip, vp, meta),
          x: imageW + (clip[0] - part.bbox[0]) * ratio,
          y: (clip[1] - part.baseline) * ratio,
          w: (clip[2] - clip[0]) * ratio, h: (clip[3] - clip[1]) * ratio });
      }
      imageW += (part.bbox[2] - part.bbox[0]) * ratio;
    }
    const imageH = ascent + descent;
    const fit = Math.min(1, Math.max(1, maxW - padding * 2) / imageW);
    for (const slice of slices) {
      slice.x *= fit; slice.y *= fit; slice.w *= fit; slice.h *= fit;
    }
    units.push({ type: "math", text: m.text, slices, padding,
      width: imageW * fit + padding * 2, imageW: imageW * fit, imageH: imageH * fit,
      ascent: Math.max(0, ascent * fit), descent: Math.max(0, descent * fit) });
    pos = match.index + match[0].length;
  }
  pushText(String(text).slice(pos));
  const lines = [];
  const newLine = (indent) => ({ runs: [], width: 0, indent, ascent: fs * 0.85, descent: fs * 0.35 });
  const textWidth = (value, run) => {
    ctx.font = run.font;
    return ctx.measureText(value).width;
  };
  let line = newLine(firstIndent || 0);
  const finishLine = () => {
    const last = line.runs[line.runs.length - 1];
    if (last && last.type === "text") {
      last.text = last.text.trimEnd();
      const width = textWidth(last.text, last);
      line.width += width - last.width; last.width = width;
      if (!last.text) line.runs.pop();
    }
    lines.push(line);
    line = newLine(0);
  };
  for (const unit of units) {
    if (unit.type === "text" && unit.text === "\n") {
      finishLine(); continue;
    }
    if (!line.runs.length && unit.type === "text" && !unit.text.trim()) continue;
    let last = line.runs[line.runs.length - 1];
    const addedWidth = () => unit.type === "math" ? unit.width
      : last && last.type === "text" && last.font === unit.font
        ? textWidth(last.text + unit.text, unit) - last.width
        : textWidth(unit.text, unit);
    let delta = addedWidth();
    if (line.width + delta > maxW - line.indent && line.runs.length) {
      finishLine(); last = null; delta = addedWidth();
      if (unit.type === "text" && !unit.text.trim()) continue;
    }
    if (!line.runs.length && delta > maxW - line.indent) line.indent = 0;
    if (unit.type === "text" && last && last.type === "text" && last.font === unit.font) {
      last.text += unit.text; last.width += delta;
    } else {
      line.runs.push(Object.assign({}, unit, { width: delta }));
    }
    line.width += delta;
    if (unit.type === "math") {
      line.ascent = Math.max(line.ascent, unit.ascent);
      line.descent = Math.max(line.descent, unit.descent);
    }
  }
  if (line.runs.length) finishLine();
  ctx.font = baseFont;
  return lines;
}

function drawInlineLine(ctx, line, x, baseline, src) {
  const baseFont = ctx.font;
  let cursor = x;
  for (const run of line.runs) {
    if (run.type === "math") {
      for (const slice of run.slices) {
        const r = slice.crop;
        ctx.drawImage(src, r.x, r.y, r.w, r.h,
          cursor + run.padding + slice.x, baseline + slice.y, slice.w, slice.h);
      }
    } else if (run.text.trim()) {
      ctx.font = run.font || baseFont;
      ctx.fillText(run.text, cursor, baseline);
    }
    cursor += run.width;
  }
  ctx.font = baseFont;
}

// 首页标题、作者和单位通常横跨双栏。它们必须从正文分栏计算中剔除，
// 否则会把左栏的 x1 撑到页面右侧，令整页译文退化成一个超宽文本框。
function detectCoverHeaderBlocks(meta) {
  const body = meta.blocks.filter((b) => !b.math && !b.skip);
  if (meta.page !== 0 || !body.length) return [];
  const mid = meta.width / 2;
  const abstract = body.find((b) => /^\s*(abstract|summary)\b/i.test(String(b.text || "")));
  const cutoff = abstract ? abstract.bbox[1] : meta.height * 0.26;
  return body.filter((b) => {
    const center = (b.bbox[0] + b.bbox[2]) / 2;
    return b.bbox[3] < cutoff - 1
      && b.bbox[0] < mid && b.bbox[2] > mid
      && Math.abs(center - mid) <= meta.width * 0.10;
  });
}

// 检测分栏：先寻找真正位于中线两侧的窄正文块，再识别双栏之前的跨栏导语。
// 不能把所有 x0 < mid 的块都塞进左栏：无显式 Abstract 标题的 TeX 首页常把
// 摘要做成一个跨栏块，旧逻辑会因此让整页退化成超宽单栏。
function detectColumns(meta, excludedIds) {
  const excluded = excludedIds || new Set();
  const body = meta.blocks.filter((b) => !b.math && !b.skip && !excluded.has(b.id));
  if (!body.length) return [];
  const mid = meta.width / 2;
  const mk = (bs) => {
    if (!bs.length) return null;
    const blocks = bs.slice().sort((a, b) => a.bbox[1] - b.bbox[1]);
    return {
      x0: Math.min(...blocks.map((b) => b.bbox[0])),
      x1: Math.max(...blocks.map((b) => b.bbox[2])),
      top: blocks[0].bbox[1],
      bottom: blocks[blocks.length - 1].bbox[3],
      blocks: blocks,
    };
  };
  const slack = Math.max(3, meta.width * 0.012);
  const leftBlocks = body.filter((b) => {
    const center = (b.bbox[0] + b.bbox[2]) / 2;
    return center < mid && b.bbox[2] <= mid + slack;
  });
  const rightBlocks = body.filter((b) => {
    const center = (b.bbox[0] + b.bbox[2]) / 2;
    return center >= mid && b.bbox[0] >= mid - slack;
  });
  const lc = mk(leftBlocks);
  const rc = mk(rightBlocks);
  // A genuine single-column paper naturally crosses the page midpoint, so it
  // produces neither a narrow left nor a narrow right candidate. Keep its
  // body as one column instead of silently returning no drawable content.
  if (!lc) return rc && rightBlocks.length === body.length ? [rc] : [mk(body)];
  if (!rc) return leftBlocks.length === body.length ? [lc] : [mk(body)];
  const substantial = (col) => col.blocks.length >= 2 || col.blocks.some((b) => {
    const height = b.bbox[3] - b.bbox[1];
    return height >= meta.height * 0.12 || String(b.text || "").length >= 160;
  });
  if (!substantial(lc) || !substantial(rc) || rc.x0 <= lc.x1 + 4) return [mk(body)];

  const assigned = new Set(leftBlocks.concat(rightBlocks).map((b) => b.id));
  const firstColumnTop = Math.min(lc.top, rc.top);
  const spanningBlocks = body.filter((b) => !assigned.has(b.id)
    && b.bbox[0] < mid && b.bbox[2] > mid
    && b.bbox[3] <= firstColumnTop - 1);
  const spanningIds = new Set(spanningBlocks.map((b) => b.id));
  // A mid-page cross-column text block needs a true banded layout. Until such a
  // block is modeled, keep the safe single-column fallback rather than dropping it.
  if (body.some((b) => !assigned.has(b.id) && !spanningIds.has(b.id))) return [mk(body)];
  const columns = [lc, rc];
  columns.spanningBlocks = spanningBlocks.sort((a, b) => a.bbox[1] - b.bbox[1]);
  return columns;
}

function recordDuoLine(ctx, layout, block, line, rich, x, baseline, dpr) {
  const baseFont = ctx.font;
  const runs = rich ? line.runs : [{ text: line, width: ctx.measureText(line).width, font: baseFont }];
  let cursor = x;
  const positioned = [];
  for (const run of runs) {
    if (run.text) {
      ctx.font = run.font || baseFont;
      const measured = ctx.measureText(run.text);
      const ascent = measured.fontBoundingBoxAscent || parseFloat(ctx.font.match(/[\d.]+px/)[0]) * .8;
      const descent = measured.fontBoundingBoxDescent || ascent * .25;
      positioned.push({
        text: run.text,
        left: cursor / dpr,
        top: (baseline - ascent) / dpr,
        width: run.width / dpr,
        naturalWidth: measured.width / dpr,
        height: (ascent + descent) / dpr,
        font: ctx.font.replace(/([\d.]+)px/, (_, size) => Number(size) / dpr + "px"),
      });
    }
    cursor += run.width;
  }
  ctx.font = baseFont;
  if (!positioned.length) return;
  const top = Math.min(...positioned.map((run) => run.top));
  const bottom = Math.max(...positioned.map((run) => run.top + run.height));
  const old = layout.get(block.id);
  const record = old || { id: block.id, top, bottom, left: x / dpr, right: cursor / dpr, lines: [] };
  record.top = Math.min(record.top, top);
  record.bottom = Math.max(record.bottom, bottom);
  record.left = Math.min(record.left, x / dpr);
  record.right = Math.max(record.right, cursor / dpr);
  record.lines.push(positioned);
  layout.set(block.id, record);
}

// 首页页眉按原始纵向位置居中绘制；译文换行时向下扩展，但不侵入摘要区。
function drawCoverHeader(ctx, blocks, map, meta, vp, scale, dpr, fam, src, layout) {
  if (!blocks.length) return 0;
  const ordered = blocks.slice().sort((a, b) => a.bbox[1] - b.bbox[1]);
  const centerX = ctx.canvas.width / 2;
  const maxW = ctx.canvas.width * 0.84;
  let bottom = 0;
  for (const b of ordered) {
    const text = map[b.id];
    if (text === undefined || text === null || !String(text).trim()) continue;
    const r = toViewportRect(b.bbox, vp, meta);
    const fs = b.font_size * scale * dpr;
    const lineH = fs * 1.32;
    const top = bottom ? Math.max(r.y, bottom + fs * 0.22) : r.y;
    ctx.font = (b.bold ? "bold " : "") + (b.italic ? "italic " : "") + fs + "px " + fam;
    ctx.fillStyle = "#1f2937";
    const rich = !!((b.inline_math && b.inline_math.length) || (b.inline_styles && b.inline_styles.length));
    const lines = rich ? layoutInlineText(ctx, text, b, fs, maxW, 0, meta, vp)
      : wrapText(ctx, String(text), fs, maxW, 0);
    let baseline = top + fs;
    let previousBottom = top;
    for (const line of lines) {
      if (rich) baseline = Math.max(baseline, previousBottom + line.ascent);
      const x = centerX - (rich ? line.width : ctx.measureText(line).width) / 2;
      if (layout) {
        if (rich) drawInlineLine(ctx, line, x, baseline, src);
        else ctx.fillText(line, x, baseline);
        recordDuoLine(ctx, layout, b, line, rich, x, baseline, dpr);
      }
      previousBottom = baseline + (rich ? line.descent : fs * 0.28);
      baseline += lineH;
    }
    bottom = previousBottom;
  }
  return bottom;
}

// 整页重排：先把整页文字层填白（连被 SKIP_RE 丢弃的节编号等也一起擦掉），
// 再贴回保护区块（表格/图片/算法框原样），最后按栏流动排版译文、绕开保护区
function reflowPage(ctx, src, meta, map, vp, scale, dpr) {
  const bodyFs = computeBodyFs(meta);
  const fam = '"Microsoft YaHei","Noto Sans SC","PingFang SC",sans-serif';
  const coverHeader = detectCoverHeaderBlocks(meta);
  const headerIds = new Set(coverHeader.map((b) => b.id));
  const cols = detectColumns(meta, headerIds);
  const spanningBlocks = cols.spanningBlocks || [];
  // Equations belong in the same reading stream as prose. Only graphics and
  // explicitly protected blocks retain their original page coordinates.
  const equations = meta.blocks.filter((b) => b.math && b.display_math && !b.skip);
  const equationIds = new Set(equations.map((b) => b.id));
  if (!cols.length && equations.length) {
    cols.push({ x0: Math.min(...equations.map((b) => b.bbox[0])),
      x1: Math.max(...equations.map((b) => b.bbox[2])),
      top: Math.min(...equations.map((b) => b.bbox[1])),
      bottom: Math.max(...equations.map((b) => b.bbox[3])), blocks: [] });
  }
  for (const b of equations) {
    const overlap = (col) => Math.min(col.x1, b.bbox[2]) - Math.max(col.x0, b.bbox[0]);
    const col = cols.reduce((best, candidate) => overlap(candidate) > overlap(best) ? candidate : best);
    col.blocks.push(b);
    col.top = Math.min(col.top, b.bbox[1]);
    col.bottom = Math.max(col.bottom, b.bbox[3]);
  }
  for (const col of cols) col.blocks.sort((a, b) => a.bbox[1] - b.bbox[1] || a.id - b.id);
  const layout = new Map();
  if (!cols.length && !coverHeader.length) return layout;
  const headerBottom = drawCoverHeader(ctx, coverHeader, map, meta, vp, scale, dpr, fam, src);
  // Full-width lead paragraphs (most often an abstract without an explicit
  // heading) are flowed before the two columns, using their original width.
  const spanningFlows = [];
  let leadBottom = headerBottom;
  for (const b of spanningBlocks) {
    const rect = toViewportRect(b.bbox, vp, meta);
    if (leadBottom) rect.y = Math.max(rect.y, leadBottom + bodyFs * scale * dpr * 0.45);
    const obstacles = (meta.protected || []).map((bbox) => toViewportRect(bbox, vp, meta))
      .filter((pr) => pr.x + pr.w > rect.x - 2 && pr.x < rect.x + rect.w + 2);
    const bottom = flowColumn(ctx, rect, [b], map, bodyFs, fam, scale, dpr,
      obstacles, meta, src, vp);
    spanningFlows.push({ rect, block: b, obstacles });
    leadBottom = Math.max(leadBottom, bottom);
  }
  const flows = cols.map((col) => {
    const colRect = toViewportRect([col.x0, col.top, col.x1, col.bottom], vp, meta);
    if (leadBottom) colRect.y = Math.max(colRect.y, leadBottom + bodyFs * scale * dpr * 0.8);
    const obstacles = [];
    const push = (bbox) => {
      const pr = toViewportRect(bbox, vp, meta);
      if (pr.x + pr.w > colRect.x - 2 && pr.x < colRect.x + colRect.w + 2) obstacles.push(pr);
    };
    for (const b of meta.blocks) if ((b.math || b.skip) && !equationIds.has(b.id)) push(b.bbox);
    for (const pr of (meta.protected || [])) push(pr);
    obstacles.sort((a, b) => a.y - b.y);
    return { col, colRect, obstacles };
  });
  // Measure every column, including plain text that grows in translation.
  let neededHeight = Math.max(src.height, leadBottom + 12 * scale * dpr);
  for (const f of flows) {
    const bottom = flowColumn(ctx, f.colRect, f.col.blocks, map, bodyFs, fam, scale, dpr,
      f.obstacles, meta, src, vp);
    neededHeight = Math.max(neededHeight, bottom + 12 * scale * dpr);
  }
  if (neededHeight > ctx.canvas.height) {
    ctx.canvas.height = Math.ceil(neededHeight);
    ctx.canvas.style.height = Math.ceil(neededHeight / dpr) + "px";
  }
  // 1) 整页填白，擦除所有原文（节编号、被丢弃块等一并清除）
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
  // 2) 贴回保护区和跳过重排的块（公式、表格数据、参考文献等）。
  const restore = (rect) => {
    const pr = toViewportRect(rect, vp, meta);
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    const sx = Math.max(0, pr.x), sy = Math.max(0, pr.y);
    const sw = Math.min(pr.w, cw - sx), sh = Math.min(pr.h, ch - sy);
    if (sw <= 0 || sh <= 0) return;
    ctx.drawImage(src, sx, sy, sw, sh, sx, sy, sw, sh);
  };
  for (const b of meta.blocks) {
    if ((b.math || b.skip) && !equationIds.has(b.id)) restore(b.bbox);
  }
  for (const rect of (meta.protected || [])) restore(rect);
  // 3) 首页页眉独立居中绘制，不参与正文栏宽度计算
  drawCoverHeader(ctx, coverHeader, map, meta, vp, scale, dpr, fam, src, layout);
  // 4) 双栏之前的跨栏导语按原始宽度排版
  for (const f of spanningFlows) {
    flowColumn(ctx, f.rect, [f.block], map, bodyFs, fam, scale, dpr,
      f.obstacles, meta, src, vp, layout);
  }
  // 5) 各栏流动排版译文（避开保护区块）
  for (const f of flows) {
    flowColumn(ctx, f.colRect, f.col.blocks, map, bodyFs, fam, scale, dpr,
      f.obstacles, meta, src, vp, layout);
  }
  return layout;
}

// 单栏流动排版：逐行写入译文，遇到保护区整体下移到其下方，保证不重叠、不截断
function flowColumn(ctx, colRect, blocks, map, bodyFs, fam, scale, dpr, obstacles, meta, src, vp, layout) {
  const fs0 = bodyFs * scale * dpr;
  let y = colRect.y + fs0 * 0.9;
  let previousBottom = null;
  for (const b of blocks) {
    if (b.math && b.display_math && !b.skip) {
      const r = toViewportRect(b.bbox, vp, meta);
      if (!(r.w > 0 && r.h > 0)) continue;
      const fit = Math.min(1, colRect.w / r.w);
      const w = r.w * fit, h = r.h * fit;
      // Preserve the horizontal alignment of multi-line equations and numbers.
      const x = Math.max(colRect.x, Math.min(r.x, colRect.x + colRect.w - w));
      let top = previousBottom === null ? colRect.y : previousBottom + fs0 * 0.65;
      for (let guard = 0; guard <= obstacles.length; guard++) {
        const hit = obstacles.find((pr) => pr.y < top + h && pr.y + pr.h > top);
        if (!hit) break;
        top = hit.y + hit.h + fs0 * 0.65;
      }
      if (layout) ctx.drawImage(src, r.x, r.y, r.w, r.h, x, top, w, h);
      previousBottom = top + h;
      y = previousBottom + fs0 * 1.5;
      continue;
    }
    const text = map[b.id];
    if (text === undefined || text === null || !String(text).trim()) continue;
    const isHeading = b.font_size > bodyFs * 1.08;
    const fs = (isHeading ? b.font_size : bodyFs) * scale * dpr;
    ctx.font = (b.bold ? "bold " : "") + (b.italic ? "italic " : "") + fs + "px " + fam;
    ctx.fillStyle = "#1f2937";
    const lh = fs * LINE_ZH;
    const rich = !!((b.inline_math && b.inline_math.length) || (b.inline_styles && b.inline_styles.length));
    let lines = rich ? layoutInlineText(ctx, text, b, fs, colRect.w, 0, meta, vp)
      : wrapText(ctx, String(text), fs, colRect.w, 0);
    const citationContinuation = /^\s*(?:18|19|20)\d{2}[a-z]?\s*[;,)；，）]/.test(b.text || "");
    const sourceIndent = Math.max(0, Number(b.first_line_indent || 0) * scale * dpr);
    const indent = (!isHeading && lines.length > 1 && !citationContinuation)
      ? Math.min(sourceIndent, fs * 3, colRect.w * 0.2) : 0;
    if (indent) lines = rich ? layoutInlineText(ctx, text, b, fs, colRect.w, indent, meta, vp)
      : wrapText(ctx, String(text), fs, colRect.w, indent);
    for (let i = 0; i < lines.length; i++) {
      const ascent = rich ? lines[i].ascent : fs * 0.85;
      const descent = rich ? lines[i].descent : fs * 0.35;
      y = Math.max(y, colRect.y + ascent);
      if (previousBottom !== null) y = Math.max(y, previousBottom + ascent + fs * 0.18);
      let top = y - ascent;
      let bot = y + descent;
      // 与保护区相交则向下跳到其下方（有上限，防死循环）
      for (let guard = 0; guard <= obstacles.length; guard++) {
        let hit = null;
        for (const pr of obstacles) {
          if (pr.y < bot && pr.y + pr.h > top) { hit = pr; break; }
        }
        if (!hit) break;
        y = Math.max(y + lh * 0.2, hit.y + hit.h + ascent + fs * 0.2);
        top = y - ascent;
        bot = y + descent;
      }
      if (layout) {
        const line = lines[i];
        const x = colRect.x + (rich ? line.indent : i === 0 ? lines.firstIndent : 0);
        if (rich) drawInlineLine(ctx, line, x, y, src);
        else ctx.fillText(line, x, y);
        recordDuoLine(ctx, layout, b, line, rich, x, y, dpr);
      }
      previousBottom = bot;
      y += lh;
    }
    y += fs * 0.35; // 段间距
  }
  return Math.max(y, previousBottom || colRect.y);
}

/* ================= 页级翻译 ================= */
let translationWorker = false;
let translationPaused = false;
let translationGeneration = 0;

function ensureDuoWindow() {
  const d = cur();
  if (!d || state.mode !== "duo" || $("app").classList.contains("hidden")) return;
  const settings = loadSettings();
  const page = d.currentPage - 1;
  const configuredRadius = Number(settings.prefetch);
  const radius = !translationPaused && settings.api_key && [1, 3].includes(configuredRadius) ? configuredRadius : 0;
  const pages = [page];
  for (let offset = 1; offset <= radius; offset++) pages.push(page + offset, page - offset);
  d.queue = pages.filter((p) => {
    const meta = d.pagesMeta[p];
    if (!meta || !hasTranslatableBlocks(meta) || d.inFlight.has(p) || d.translationErrors[p]) return false;
    if (d.translations[p] && d.translations[p].complete !== false) return false;
    return (!translationPaused && settings.api_key) || !d.translationChecked.has(p);
  });
  runWorkers();
  updateTranslationNotice(d);
}

function runWorkers() {
  const d = cur();
  if (translationWorker || !d?.queue.length || state.mode !== "duo" || $("app").classList.contains("hidden")) return;
  const page = d.queue.shift();
  translationWorker = true;
  d.inFlight.add(page);
  translateOne(d, page).finally(() => {
    d.inFlight.delete(page);
    translationWorker = false;
    const active = cur();
    if (active && state.mode === "duo" && !$("app").classList.contains("hidden")) {
      ensureDuoWindow();
      if (active === d && page === d.currentPage - 1) renderDuo();
    }
  });
}

async function translateOne(d, page) {
  const settings = loadSettings();
  const generation = translationGeneration;
  const cacheOnly = translationPaused || !settings.api_key;
  d.cachedLookupPage = cacheOnly ? page : null;
  try {
    const response = await fetch("/api/translate_page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pdf_hash: d.id, page, settings, cached_only: cacheOnly }),
    });
    const data = await response.json();
    if (generation !== translationGeneration) return;
    if (response.ok || data.code === "translation_incomplete") {
      if (data.blocks?.length || (response.ok && data.complete !== false)) d.translations[page] = data;
      d.translationChecked.add(page);
      if (!response.ok) d.translationErrors[page] = data;
      else delete d.translationErrors[page];
      return;
    }
    throw new Error(typeof data.detail === "string" ? data.detail : `翻译请求失败（HTTP ${response.status}）`);
  } catch (error) {
    if (generation === translationGeneration) {
      d.translationErrors[page] = { detail: error.message || "无法连接本机翻译服务", code: "request_failed" };
    }
  }
}

function updateTranslationNotice(d) {
  const p = d.currentPage - 1;
  const error = d.translationErrors[p];
  const result = d.translations[p];
  const busy = d.inFlight.has(p);
  const queued = d.queue.includes(p);
  const needsKey = !loadSettings().api_key;
  const backgroundPage = [...d.inFlight].find((page) => page !== p && page !== d.cachedLookupPage);
  const showError = Boolean(error && !busy && !queued);
  const showSetup = needsKey && !busy && !queued && !result?.blocks?.length && hasTranslatableBlocks(d.pagesMeta[p]);
  const notice = $("translationNotice");
  const explanation = $("translationMessage");
  notice.classList.toggle("hidden", !showError && !showSetup);
  notice.classList.toggle("translation-setup", showSetup && !showError);
  const detail = showError ? error.detail : showSetup ? "配置翻译服务后即可查看译文。" : "";
  if (explanation.textContent !== detail) explanation.textContent = detail;
  $("btnRetryTranslation").textContent = needsKey ? "打开设置" : "重试";

  let status = "待翻译";
  let tone = "idle";
  if (busy || queued) {
    const cacheLookup = busy ? d.cachedLookupPage === p : translationPaused || needsKey;
    status = cacheLookup ? "检查缓存" : busy ? "翻译中…" : "已排队";
    tone = "working";
  } else if (showError) {
    status = result?.blocks?.length ? "译文未完成" : "翻译失败";
    tone = "error";
  } else if (backgroundPage !== undefined) {
    status = `翻译第 ${backgroundPage + 1} 页`;
    tone = "working";
  } else if (translationPaused) {
    status = "已暂停";
    tone = "paused";
  } else if (!hasTranslatableBlocks(d.pagesMeta[p])) {
    status = "无需翻译";
  } else if (result && result.complete !== false) {
    status = "译文就绪";
    tone = "ready";
  } else if (needsKey) {
    status = "未配置";
  }

  const queueStatus = $("translationQueueStatus");
  if (queueStatus.textContent !== status) queueStatus.textContent = status;
  queueStatus.dataset.tone = tone;
  const pending = d.queue.map((page) => `第 ${page + 1} 页`).join("、");
  queueStatus.title = pending ? `${status} · 排队中：${pending}` : status;

  const pause = $("btnPauseTranslation");
  const action = needsKey ? "settings" : translationPaused ? "resume" : "pause";
  const label = { settings: "打开翻译设置", resume: "继续翻译", pause: "暂停翻译" }[action];
  pause.dataset.action = action;
  pause.title = label;
  pause.setAttribute("aria-label", label);
  $("translationActionLabel").textContent = label;
}

function toggleTranslationPause() {
  translationPaused = !translationPaused;
  ensureDuoWindow();
  if (cur() && state.mode === "duo") renderDuo();
}

$("btnRetryTranslation").onclick = () => {
  const d = cur();
  if (!d) return;
  if (!loadSettings().api_key) { openSettings(); return; }
  if (translationPaused) translationPaused = false;
  delete d.translationErrors[d.currentPage - 1];
  ensureDuoWindow();
  renderDuo();
};
$("btnPauseTranslation").addEventListener("click", () => {
  if (!loadSettings().api_key) openSettings();
  else toggleTranslationPause();
});

/* ================= 视图模式 ================= */
function fitDuoScale(d, side) {
  const meta = d.pagesMeta[d.currentPage - 1] || d.pagesMeta[0];
  if (!meta) return 1;
  const scroller = $(side === "original" ? "duoOriginalScroll" : "duoTranslationScroll");
  const style = getComputedStyle(scroller);
  const avail = scroller.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  return Math.max(0.25, Math.min(4, avail / meta.width));
}

function applyDuoOriginalVisibility(d) {
  const collapsed = !d.duoShowOriginal;
  $("duoView").querySelector(".duo-body").classList.toggle("original-collapsed", collapsed);
  $("duoOriginalPane").inert = collapsed;
  $("duoOriginalPane").setAttribute("aria-hidden", String(collapsed));
}

function waitForDuoVisibilityMotion() {
  if (reduceMotion.matches) return Promise.resolve();
  const pane = $("duoOriginalPane");
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      pane.removeEventListener("transitionend", onEnd);
      clearTimeout(timer);
      resolve();
    };
    const onEnd = (event) => {
      if (event.target === pane && event.propertyName === "flex-grow") finish();
    };
    const timer = setTimeout(finish, isMac ? 350 : 500);
    pane.addEventListener("transitionend", onEnd);
  });
}

function syncDuoControls(d) {
  applyDuoOriginalVisibility(d);
  if (d.duoShowOriginal && (d.duoFitOriginal || d.duoOriginalScale == null)) {
    d.duoOriginalScale = fitDuoScale(d, "original");
  }
  if (d.duoFitTranslation || d.duoScale == null) d.duoScale = fitDuoScale(d, "translation");
  updateZoomLabel();
}

function zoomDuoBy(side, factor) {
  const d = cur(); if (!d || state.mode !== "duo") return;
  if (!d.duoShowOriginal) side = "translation";
  const original = side === "original";
  const key = original ? "duoOriginalScale" : "duoScale";
  const next = Math.min(4, Math.max(0.25, d[key] * factor));
  if (Math.abs(next - d[key]) < 0.001) return;
  d.duoZoomTarget = side;
  d[original ? "duoFitOriginal" : "duoFitTranslation"] = false;
  d[key] = next;
  renderDuo().then(persistCurrentProgress);
}

function fitDuoWidth(side) {
  const d = cur(); if (!d || state.mode !== "duo") return;
  d.duoZoomTarget = side;
  d[side === "original" ? "duoFitOriginal" : "duoFitTranslation"] = true;
  renderDuo().then(persistCurrentProgress);
}

async function setDuoOriginalVisibility(show) {
  const d = cur(); if (!d || state.mode !== "duo") return;
  if (duoVisibilityTransition) {
    await duoVisibilityTransition;
    if (cur() !== d || state.mode !== "duo") return;
  }
  if (d.duoShowOriginal === show) return;
  persistCurrentProgress();
  d.duoShowOriginal = show;
  if (!d.duoShowOriginal && d.reading?.original) d.hiddenOriginalAnchor = { page: d.currentPage, anchor: d.reading.original };
  if (!d.duoShowOriginal) d.duoZoomTarget = "translation";
  cancelDuoRender();
  const layoutJob = { doc: d, tasks: new Set(), layout: true };
  duoRenderJob = layoutJob;
  const motion = waitForDuoVisibilityMotion();
  duoVisibilityTransition = motion;
  applyDuoOriginalVisibility(d);
  updateReaderView();
  try {
    await motion;
  } finally {
    if (duoVisibilityTransition === motion) duoVisibilityTransition = null;
    if (duoRenderJob === layoutJob) duoRenderJob = null;
  }
  if (cur() !== d || state.mode !== "duo") return;
  await renderDuo();
  persistCurrentProgress();
}

function setDuoZoomTarget(side) {
  const d = cur();
  if (!d || (side === "original" && !d.duoShowOriginal)) return;
  d.duoZoomTarget = side;
  updateZoomLabel();
}

function updateZoomLabel() {
  const d = cur(); if (!d) return;
  const dual = state.mode === "duo";
  const side = d.duoShowOriginal ? d.duoZoomTarget : "translation";
  const original = side === "original";
  const scale = (dual ? (original ? d.duoOriginalScale : d.duoScale) : d.scale) || 1;
  const fit = dual ? (original ? d.duoFitOriginal : d.duoFitTranslation) : d.fitWidth;
  $("duoZoomTarget").value = side;
  $("zoomVal").textContent = Math.round(scale * 100) + "%";
  $("btnZoomOut").disabled = scale <= (dual ? 0.25 : 0.3);
  $("btnZoomIn").disabled = scale >= 4;
  $("btnFitWidth").setAttribute("aria-pressed", String(fit));
  $("btnDuoSync").setAttribute("aria-pressed", String(d.duoSync));
}

function syncDockedNavigation() {
  const sidebar = $("sidebar");
  const viewer = $("viewer");
  const cluster = $("sidebarControlCluster");
  const dock = $("readerNavigationDock");
  const collapsed = sidebar.classList.contains("collapsed");
  const immersive = $("app").classList.contains("reader-chrome-collapsed");
  const inline = immersive && collapsed;
  const destination = immersive ? (inline ? dock : sidebar) : $("readerNavigationSlot");

  dock.classList.toggle("hidden", !inline);
  viewer.classList.toggle("has-docked-navigation", inline);
  if (cluster.parentElement !== destination) {
    const focused = cluster.contains(document.activeElement) ? document.activeElement : null;
    destination.prepend(cluster);
    focused?.focus({ preventScroll: true });
  }
}

function updateReaderView() {
  const d = cur();
  const translating = state.mode === "duo";
  const compare = translating && d?.duoShowOriginal;
  const selected = translating ? (compare ? "duo" : "translation") : "original";
  $("viewSeg").dataset.activeMode = selected;
  for (const button of $("viewSeg").querySelectorAll("button")) {
    const active = button.dataset.view === selected;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  $("readerPairTools").classList.toggle("hidden", !compare);
  $("readerFlowOptions").classList.toggle("hidden", translating);
  $("readerTranslationActions").classList.toggle("hidden", !translating);
  $("translationQueueStatus").classList.toggle("hidden", !translating);
  for (const button of $("readerFlowOptions").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.flow === d?.originalMode));
  }
  updateZoomLabel();
}

async function selectReaderView(view) {
  const d = cur();
  if (!d) return;
  if (view === "original") {
    if (state.mode === "duo") await applyMode(d.originalMode);
    return;
  }
  const showOriginal = view === "duo";
  if (duoVisibilityTransition) await duoVisibilityTransition;
  if (cur() !== d) return;
  if (state.mode === "duo") {
    await setDuoOriginalVisibility(showOriginal);
    return;
  }
  d.duoShowOriginal = showOriginal;
  if (!showOriginal) d.duoZoomTarget = "translation";
  await applyMode("duo");
}

function applyMode(mode, restoring = false) {
  if (!["continuous", "single", "duo"].includes(mode)) return;
  if (!restoring) {
    persistCurrentProgress();
    if (cur()) { cur().pendingRestore = null; cur().restoring = false; cur().lateTranslationAnchor = null; cur().hiddenOriginalAnchor = null; }
  }
  readerNotes.clearSelection();
  if (mode !== "single") cancelSingleRender();
  if (mode !== "duo") {
    cancelDuoRender();
    if (state.mode === "duo") {
      readerNotes.unmount($("duoOrig").parentElement);
      readerSearch.detach($("duoTrans").parentElement);
      duoPaint.original = duoPaint.translation = null;
    }
  }
  state.mode = mode;
  syncSearchScope();
  $("continuousView").classList.toggle("hidden", mode !== "continuous");
  $("singleView").classList.toggle("hidden", mode !== "single");
  $("duoView").classList.toggle("hidden", mode !== "duo");
  syncDockedNavigation();
  readerNotes.sync();
  const d = cur();
  if (!d) return;
  d.mode = mode;
  if (mode !== "duo") d.originalMode = mode;
  updateReaderView();
  let rendered;
  if (mode === "continuous") {
    if (restoring) restoreReadingPosition(d);
    else { scrollToPage(d.currentPage); renderVisible(); }
  }
  else if (mode === "single") rendered = renderSingle();
  else if (mode === "duo") { ensureDuoWindow(); rendered = renderDuo(); }
  readerSearch.refresh(d);
  if (d.searchMatch && d.currentPage === d.searchMatch.page + 1) readerSearch.select(d, d.searchMatch);
  return Promise.resolve(rendered).then(() => { if (cur() === d && !restoring) persistCurrentProgress(); });
}

/* ================= 翻页 ================= */
function setCurrentLabel(n) {
  const d = cur(); if (!d) return;
  const total = d.pagesMeta.length;
  n = Math.max(1, Math.min(total, n));
  d.currentPage = n;
  $("pageInput").value = n;
  $("pageCount").textContent = total;
  $("pageInput").max = total;
  $("btnPrev").disabled = n <= 1;
  $("btnNext").disabled = n >= total;
  updateThumbActive();
}

function goToPage(n) {
  const d = cur(); if (!d) return;
  const total = d.pagesMeta.length;
  if (n < 1 || n > total) return;
  readerSearch.cancelJump();
  readerNotes.clearSelection();
  d.pendingRestore = null; d.restoring = false; d.lateTranslationAnchor = null; d.hiddenOriginalAnchor = null;
  setCurrentLabel(n);
  if (state.mode === "continuous") { scrollToPage(n); renderVisible(); }
  else if (state.mode === "single") return renderSingle().then(persistCurrentProgress);
  else if (state.mode === "duo") { ensureDuoWindow(); return renderDuo().then(persistCurrentProgress); }
  if (state.mode === "continuous") persistCurrentProgress();
}

async function readOverviewSource(doc, source) {
  if (cur() !== doc) return;
  const meta = doc.pagesMeta[source.page - 1];
  if (!meta) return;
  await selectReaderView("original");
  if (cur() !== doc) return;
  await goToPage(source.page);
  const block = meta.blocks.find((item) => item.id === source.block);
  if (!block) return;
  try {
    const page = await doc.pdfDoc.getPage(source.page);
    if (cur() !== doc || doc.currentPage !== source.page || state.mode === "duo") return;
    const host = state.mode === "continuous" ? doc.slots[source.page - 1]?.el : $("singlePage");
    if (!host) return;
    const r = toViewportRect(block.bbox, page.getViewport({ scale: doc.scale }), meta);
    document.querySelector(".overview-source-mark")?.remove();
    const mark = document.createElement("div");
    mark.className = "overview-source-mark";
    mark.setAttribute("aria-hidden", "true");
    Object.assign(mark.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
    host.append(mark);
    mark.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    if (state.mode === "continuous") renderVisible();
    persistCurrentProgress();
    setTimeout(() => mark.remove(), 3600);
  } catch (_) {
    // The reader has already opened the cited page.
  }
}

/* ================= 缩放 ================= */
function zoomBy(f) {
  const d = cur(); if (!d) return;
  if (state.mode === "duo") {
    zoomDuoBy(d.duoZoomTarget, f);
    return;
  }
  const next = Math.min(4, Math.max(0.3, d.scale * f));
  if (Math.abs(next - d.scale) < 0.01) return;
  d.fitWidth = false;
  d.scale = next;
  onScaleChange();
}

function onScaleChange() {
  const d = cur(); if (!d) return;
  updateZoomLabel();
  readerNotes.clearSelection();
  const keep = d.currentPage;
  d.renderToken++;
  buildSlots();
  if (state.mode === "continuous") { scrollToPage(keep); renderVisible(); }
  else if (state.mode === "single") renderSingle().then(persistCurrentProgress);
  else renderDuo();
  if (state.mode === "continuous") persistCurrentProgress();
}

/* ================= 侧栏：缩略图 / 目录 / 书签 ================= */
let thumbObserver = null;

function buildThumbs() {
  const d = cur(); if (!d) return;
  const panel = $("thumbsPanel");
  if (thumbObserver) thumbObserver.disconnect();
  // Cancel only thumbnail jobs belonging to the old sidebar, not main-page renders.
  for (const el of panel.children) {
    if (el.__t && el.__t.renderTask) el.__t.renderTask.cancel();
  }
  panel.innerHTML = "";
  d.thumbs = [];
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) {
        const t = en.target.__t;
        renderThumb(t).then(() => { if (t.rendered) io.unobserve(t.el); });
      }
    }
  }, { root: panel, rootMargin: "300px" });
  thumbObserver = io;
  for (let i = 0; i < d.pagesMeta.length; i++) {
    const w = document.createElement("button");
    w.type = "button";
    w.className = "thumb" + (i === d.currentPage - 1 ? " active" : "");
    w.setAttribute("aria-label", "跳转到第 " + (i + 1) + " 页");
    if (i === d.currentPage - 1) w.setAttribute("aria-current", "page");
    const preview = document.createElement("div");
    preview.className = "thumb-preview";
    const meta = d.pagesMeta[i];
    preview.style.aspectRatio = meta.width + " / " + meta.height;
    const cv = document.createElement("canvas");
    cv.setAttribute("aria-hidden", "true");
    preview.appendChild(cv);
    w.appendChild(preview);
    const tn = document.createElement("div");
    tn.className = "tnum"; tn.textContent = "第 " + (i + 1) + " 页";
    w.appendChild(tn);
    w.addEventListener("click", () => goToPage(i + 1));
    panel.appendChild(w);
    const t = { doc: d, el: w, preview, canvas: cv, idx: i, rendered: false, rendering: false, renderTask: null };
    w.__t = t;
    d.thumbs.push(t);
    io.observe(w);
  }
}

async function renderThumb(t) {
  if (t.rendered || t.rendering || !t.el.isConnected) return;
  t.rendering = true;
  let buffer = null;
  try {
    // Keep the owning document: a tab switch must not render a different PDF here.
    const page = await t.doc.pdfDoc.getPage(t.idx + 1);
    if (!t.el.isConnected || t.preview.clientWidth < 1) return;
    const original = page.getViewport({ scale: 1 });
    t.preview.style.aspectRatio = original.width + " / " + original.height;
    const density = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.ceil(t.preview.getBoundingClientRect().width * density));
    const height = Math.max(1, Math.ceil(width * original.height / original.width));
    // Supersample thin text/table rules, then average them down to physical pixels.
    // Direct rendering at ~90px forces many subpixel strokes into dark stripes.
    const vp = page.getViewport({ scale: width * 2 / original.width });
    buffer = document.createElement("canvas");
    buffer.width = Math.ceil(vp.width); buffer.height = Math.ceil(vp.height);
    t.renderTask = page.render({ canvasContext: buffer.getContext("2d"), viewport: vp, background: "#ffffff" });
    await t.renderTask.promise;
    if (!t.el.isConnected) return;
    t.canvas.width = width; t.canvas.height = height;
    const ctx = t.canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(buffer, 0, 0, buffer.width, buffer.height, 0, 0, width, height);
    t.rendered = true;
  } catch (e) {
    if (e.name !== "RenderingCancelledException" && t.el.isConnected) console.error(e);
  } finally {
    t.rendering = false;
    t.renderTask = null;
    if (buffer) { buffer.width = 0; buffer.height = 0; }
  }
}

function updateThumbActive() {
  const d = cur(); if (!d || !d.thumbs) return;
  d.thumbs.forEach((t) => {
    const active = t.idx === d.currentPage - 1;
    t.el.classList.toggle("active", active);
    if (active) t.el.setAttribute("aria-current", "page");
    else t.el.removeAttribute("aria-current");
  });
  const active = d.thumbs[d.currentPage - 1];
  if (active) active.el.scrollIntoView({ block: "nearest" });
}

function renderOutlinePanel() {
  const d = cur();
  const panel = $("outlinePanel");
  panel.innerHTML = "";
  if (!d || !d.outline.length) {
    panel.innerHTML = '<div class="empty-hint">此 PDF 没有目录</div>';
    return;
  }
  const ul = document.createElement("ul");
  ul.className = "otree";
  let prevLevel = 0;
  let stack = [ul];
  for (const [level, title, page] of d.outline) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "item";
    btn.style.paddingLeft = (8 + (level - 1) * 14) + "px";
    btn.innerHTML = "<span>" + escapeHtml(title) + "</span><span class='pg'>" + page + "</span>";
    btn.addEventListener("click", () => goToPage(Math.min(page, d.pagesMeta.length)));
    li.appendChild(btn);
    if (level > prevLevel) {
      const child = document.createElement("ul");
      child.className = "otree";
      stack[stack.length - 1].appendChild(child);
      stack.push(child);
    } else if (level < prevLevel) {
      while (stack.length - 1 > level) stack.pop();
    }
    stack[stack.length - 1].appendChild(li);
    prevLevel = level;
  }
  panel.appendChild(ul);
}

function renderBookmarksPanel() {
  const d = cur();
  const panel = $("bookmarksPanel");
  panel.innerHTML = "";
  const addBtn = document.createElement("button");
  addBtn.className = "btn addbookmark";
  addBtn.textContent = "＋ 添加当前页书签";
  addBtn.addEventListener("click", addBookmark);
  panel.appendChild(addBtn);
  if (!d) return;
  const list = loadBookmarks(d.id);
  if (!list.length) {
    const e = document.createElement("div");
    e.className = "empty-hint";
    e.textContent = "暂无书签\n在任意页点击上方按钮添加";
    panel.appendChild(e);
    return;
  }
  const wrap = document.createElement("div");
  wrap.style.marginTop = "10px";
  list.forEach((bm, i) => {
    const row = document.createElement("div");
    row.className = "bm-item";
    const name = document.createElement("span");
    name.className = "bm-name";
    name.textContent = "p" + bm.page + " · " + bm.title;
    name.title = bm.title;
    name.addEventListener("click", () => goToPage(Math.min(bm.page, d.pagesMeta.length)));
    const del = document.createElement("span");
    del.className = "bm-del"; del.textContent = "×"; del.title = "删除";
    del.addEventListener("click", () => {
      const l = loadBookmarks(d.id);
      l.splice(i, 1);
      saveBookmarks(d.id, l);
      renderBookmarksPanel();
    });
    row.appendChild(name); row.appendChild(del);
    wrap.appendChild(row);
  });
  panel.appendChild(wrap);
}

function addBookmark() {
  const d = cur(); if (!d) return;
  const meta = d.pagesMeta[d.currentPage - 1];
  let title = "第 " + d.currentPage + " 页";
  if (meta && meta.blocks.length) {
    const first = meta.blocks.find((b) => b.text.trim());
    if (first) title = first.text.trim().slice(0, 40);
  }
  const list = loadBookmarks(d.id);
  list.push({ page: d.currentPage, title, time: Date.now() });
  saveBookmarks(d.id, list);
  renderBookmarksPanel();
  toast("已添加书签");
}

function switchSidebar(tab) {
  document.querySelectorAll(".shead .s").forEach((s) => s.classList.toggle("active", s.dataset.tab === tab));
  $("thumbsPanel").classList.toggle("hidden", tab !== "thumbs");
  $("outlinePanel").classList.toggle("hidden", tab !== "outline");
  $("bookmarksPanel").classList.toggle("hidden", tab !== "bookmarks");
  $("searchPanel").classList.toggle("hidden", tab !== "search");
}

/* ================= 全文搜索 ================= */
let searchRun = 0;
let lastSearchResults = null;
let sidebarBeforeSearch = "thumbs";

function syncSearchScope() {
  const d = cur();
  if (!d) return;
  const scope = $("searchScope");
  scope.classList.toggle("hidden", state.mode !== "duo");
  if (state.mode !== "duo" && d.searchScope === "translation") {
    scope.value = d.searchScope = "original";
    if (d.searchQuery && !$("searchBox").classList.contains("hidden")) runSearch(d.searchQuery);
  }
}

async function findTranslated(d, query) {
  const response = await fetch("/api/cached_translations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pdf_hash: d.id, settings: translationCacheSettings() }),
  });
  if (!response.ok) throw new Error("无法读取已保存的译文");
  const { pages } = await response.json();
  const results = [];
  const match = query.toLowerCase();
  for (const { page, blocks } of pages) {
    for (const block of blocks) {
      const haystack = block.text.toLowerCase();
      let idx = -match.length;
      while ((idx = haystack.indexOf(match, idx + match.length)) !== -1) {
        results.push({ page, blockId: block.id, text: block.text, idx, end: idx + match.length, scope: "translation" });
      }
    }
  }
  return { results, translatedPages: pages.length };
}

function openSearch() {
  ReaderChrome.reveal();
  if ($("searchBox").classList.contains("hidden")) {
    sidebarBeforeSearch = document.querySelector(".shead .s.active")?.dataset.tab || "thumbs";
  }
  if ($("sidebar").classList.contains("collapsed")) $("btnSidebar").click();
  $("searchBox").classList.remove("hidden");
  syncSearchScope();
  $("btnDocumentSearch").setAttribute("aria-expanded", "true");
  $("searchInput").focus();
  $("searchInput").select();
}

function closeSearch() {
  searchRun++;
  const restoreFocus = $("searchBox").contains(document.activeElement) || $("searchPanel").contains(document.activeElement);
  $("searchBox").classList.add("hidden");
  $("btnDocumentSearch").setAttribute("aria-expanded", "false");
  if (!$("searchPanel").classList.contains("hidden")) switchSidebar(sidebarBeforeSearch);
  $("searchInput").value = "";
  const d = cur();
  if (d) {
    d.searchResults = []; d.searchIdx = -1; d.searchMatch = null; d.searchQuery = ""; d.searchLoading = false;
    clearHighlights();
    renderSearchPanel();
  }
  if (restoreFocus) $("btnDocumentSearch").focus({ preventScroll: true });
}

function clearHighlights() {
  const d = cur(); if (!d) return;
  readerSearch.cancelJump();
  readerSearch.refresh(d);
}

async function runSearch(query) {
  const d = cur(); if (!d) return;
  const token = ++searchRun, q = query.trim();
  d.searchResults = []; d.searchIdx = -1; d.searchMatch = null;
  d.searchQuery = q; d.searchLoading = !!q;
  clearHighlights(); renderSearchPanel();
  if (!q) return;
  switchSidebar("search");
  const active = () => token === searchRun && cur() === d;
  try {
    const translated = d.searchScope === "translation";
    const found = translated ? await findTranslated(d, q) : { results: await readerSearch.find(d, q, active) };
    if (!active()) return;
    d.searchResults = found.results;
    d.searchLoading = false;
    d.translatedSearchPages = found.translatedPages;
    d.searchIdx = found.results.length ? 0 : -1;
    renderSearchPanel();
    if (found.results.length) goToMatch(0);
  } catch (error) {
    if (!active()) return;
    d.searchLoading = false; renderSearchPanel();
    console.error("PDF search", error); toast("搜索失败，请重试", 4000);
  }
}

function buildSnippet(text, idx, qlen) {
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + qlen + 60);
  const pre = (start > 0 ? "…" : "") + escapeHtml(text.slice(start, idx));
  const m = escapeHtml(text.slice(idx, idx + qlen));
  const post = escapeHtml(text.slice(idx + qlen, end)) + (end < text.length ? "…" : "");
  return pre + "<mark>" + m + "</mark>" + post;
}

function renderSearchPanel() {
  const d = cur();
  const panel = $("searchPanel");
  $("btnSearchResults").classList.toggle("hidden", !d?.searchQuery || $("searchBox").classList.contains("hidden"));
  if (!d?.searchQuery || $("searchBox").classList.contains("hidden")) {
    if (!panel.classList.contains("hidden")) switchSidebar(sidebarBeforeSearch);
    panel.replaceChildren();
    lastSearchResults = null;
    $("searchCount").textContent = "";
    return;
  }
  const results = d.searchResults;
  $("searchCount").textContent = d.searchLoading ? "搜索中…" : results.length ? `${d.searchIdx + 1}/${results.length}` : "0/0";
  if (results !== lastSearchResults || !results.length) {
    const fragment = document.createDocumentFragment();
    if (!results.length) {
      const status = document.createElement("p");
      status.className = "empty-hint";
      status.textContent = d.searchLoading ? "正在搜索…" : d.searchScope === "translation" && !d.translatedSearchPages
        ? "本篇暂无已保存的译文。" : "没有找到匹配结果。";
      fragment.append(status);
    }
    results.forEach((r, k) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sres";
      button.innerHTML = '<span class="spg">p' + (r.page + 1) + '</span><span class="stxt">' + buildSnippet(r.text, r.idx, r.end - r.idx) + "</span>";
      button.addEventListener("click", () => goToMatch(k));
      button.addEventListener("keydown", (event) => {
        if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
        event.preventDefault();
        const next = (k + (event.key === "ArrowUp" ? -1 : 1) + results.length) % results.length;
        panel.querySelectorAll(".sres")[next]?.focus();
        goToMatch(next);
      });
      fragment.append(button);
    });
    panel.replaceChildren(fragment);
    lastSearchResults = results;
  }
  for (const [index, button] of [...panel.querySelectorAll(".sres")].entries()) {
    button.classList.toggle("active", index === d.searchIdx);
    button.setAttribute("aria-current", String(index === d.searchIdx));
  }
  panel.querySelector(".sres.active")?.scrollIntoView({ block: "nearest" });
}

async function goToMatch(k) {
  const d = cur();
  if (!d?.searchResults.length) return;
  k = (k + d.searchResults.length) % d.searchResults.length;
  d.searchIdx = k;
  const result = d.searchResults[k];
  d.searchMatch = result;
  renderSearchPanel();
  if (result.scope === "translation" && !d.translations[result.page]) {
    try {
      const response = await fetch("/api/translate_page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdf_hash: d.id, page: result.page, settings: translationCacheSettings(), cached_only: true }),
      });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (cur() !== d || d.searchMatch !== result) return;
      if (data.blocks?.length) d.translations[result.page] = data;
    } catch (_) {
      if (cur() === d && d.searchMatch === result) toast("无法打开已保存的译文");
      return;
    }
  } else if (state.mode === "duo" && result.scope !== "translation" && !d.duoShowOriginal) {
    await setDuoOriginalVisibility(true);
  }
  if (cur() !== d || d.searchMatch !== result) return;
  goToPage(result.page + 1);
  readerSearch.select(d, result);
}

function nextMatch(backward) {
  const d = cur(); if (!d || !d.searchResults.length) return;
  goToMatch(d.searchIdx + (backward ? -1 : 1));
}

/* ================= 设置 ================= */
let settingsReturnFocus = null;
let connectionCheck = 0;
let defaultTranslationPrompt = "";
let translationPromptRequest = null;

async function showDefaultTranslationPrompt() {
  const input = $("setTranslationPrompt");
  const reset = $("btnResetTranslationPrompt");
  const status = $("translationPromptStatus");
  status.classList.add("hidden");
  if (!defaultTranslationPrompt) {
    input.placeholder = "正在读取默认提示词…";
    translationPromptRequest ??= fetch("/api/translation_prompt").then(async (response) => {
      if (!response.ok) throw new Error("Could not load default translation prompt");
      const value = (await response.json()).default;
      if (typeof value !== "string" || !value) throw new Error("Missing default translation prompt");
      return value;
    });
    try {
      defaultTranslationPrompt = await translationPromptRequest;
    } catch (_) {
      status.textContent = "暂时无法读取默认提示词。重新展开后可重试。";
      status.classList.remove("hidden");
      return;
    } finally {
      input.placeholder = "";
      translationPromptRequest = null;
    }
  }
  if (!input.value && !input.dataset.edited) input.value = defaultTranslationPrompt;
  reset.disabled = false;
}

function readSettingsForm() {
  const temperature = $("setTemperature").valueAsNumber;
  const prompt = $("setTranslationPrompt").value.trim();
  return {
    api_key: $("setApiKey").value.trim(),
    model: $("setModel").value || DEFAULT_SETTINGS.model,
    base_url: $("setBaseUrl").value.trim() || DEFAULT_SETTINGS.base_url,
    target: $("setTarget").value.trim() || DEFAULT_SETTINGS.target,
    translation_prompt: prompt === defaultTranslationPrompt ? "" : prompt,
    temperature: Number.isFinite(temperature) ? Math.min(1, Math.max(0, temperature)) : DEFAULT_SETTINGS.temperature,
    prefetch: Number($("setPrefetch").value),
  };
}

function resetConnectionCheck() {
  connectionCheck++;
  $("btnTestConnection").disabled = false;
  $("connectionStatus").textContent = "";
  delete $("connectionStatus").dataset.result;
}

async function testConnection() {
  const check = ++connectionCheck;
  const button = $("btnTestConnection");
  const status = $("connectionStatus");
  status.textContent = "正在测试…";
  delete status.dataset.result;
  button.disabled = true;
  try {
    const response = await fetch("/api/translation_connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(readSettingsForm()),
    });
    const data = await response.json();
    if (check !== connectionCheck) return;
    status.textContent = response.ok && data.ok ? "连接成功，可以翻译。" : data.message || "连接测试失败。";
    status.dataset.result = response.ok && data.ok ? "success" : "error";
  } catch (_) {
    if (check !== connectionCheck) return;
    status.textContent = "无法连接本机 Folio 服务。";
    status.dataset.result = "error";
  } finally {
    if (check === connectionCheck) button.disabled = false;
  }
}

function openSettings() {
  if (!$("settingsModal").classList.contains("hidden")) return;
  settingsReturnFocus = document.activeElement.closest("#readerViewMenu")?.querySelector("summary") || document.activeElement;
  resetConnectionCheck();
  const s = loadSettings();
  $("setApiKey").value = s.api_key;
  $("setModel").value = s.model;
  $("setBaseUrl").value = s.base_url;
  $("setTarget").value = s.target;
  const input = $("setTranslationPrompt");
  delete input.dataset.edited;
  input.value = s.translation_prompt || defaultTranslationPrompt;
  if ($("translationPromptSettings").open) showDefaultTranslationPrompt();
  $("setTemperature").value = s.temperature;
  $("setPrefetch").value = [0, 1, 3].includes(Number(s.prefetch)) ? String(s.prefetch) : "0";
  $("setApiKey").type = "password";
  $("btnShowKey").textContent = "显示";
  $("settingsModal").classList.remove("hidden");
  $("settingsModal").inert = false;
  $("setApiKey").focus({ preventScroll: true });
}

function closeSettings() {
  if ($("settingsModal").classList.contains("hidden")) return;
  resetConnectionCheck();
  $("settingsModal").inert = true;
  $("settingsModal").classList.add("hidden");
  if (settingsReturnFocus?.isConnected && settingsReturnFocus.getClientRects().length) {
    settingsReturnFocus.focus({ preventScroll: true });
  }
  settingsReturnFocus = null;
}

function handleSettingsKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeSettings();
  } else if (e.key === "Tab") {
    const controls = [...$("settingsModal").querySelectorAll(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]'
    )].filter((el) => el.getClientRects().length && !el.closest("[inert]"));
    const first = controls[0], last = controls[controls.length - 1];
    if (!first) return;
    if (!controls.includes(document.activeElement) || (e.shiftKey && document.activeElement === first)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
  }
}

/* ================= 桌面命令 ================= */
window.folioMenuCommand = async (command, detail) => {
  if (command === "imported") {
    const { hashes = [], failed = 0, total = hashes.length + failed } = detail || {};
    if (hashes.length) {
      if (total === 1) await reopenDoc(hashes[0]);
      else {
        showLibrary();
        await PaperLibrary.reload();
      }
    }
    if (total > 1 || failed) toast(`已导入 ${hashes.length} 份 PDF${failed ? `，${failed} 份失败` : ""}`);
    return;
  }
  if (!$("storageModal").classList.contains("hidden") || $("paperOverview").open) return;
  if (command === "settings") { openSettings(); return; }
  if (!$("settingsModal").classList.contains("hidden")) return;
  if (command === "open") $("fileInput").click();
  else if (command === "close" && cur() && !$("app").classList.contains("hidden")) closeTab(state.active);
};

/* ================= 初始化 ================= */
async function init() {
  $("btnDocumentSearch").title = `搜索文档（${shortcutModifier}+F）`;
  $("btnLibrarySearch").title = `搜索论文标题（${shortcutModifier}+F）`;
  $("librarySearchShortcut").textContent = `${shortcutModifier} F`;
  readerNotes.init({ getDoc: cur, getMode: () => state.mode, goToPage, revealOriginal: () => setDuoOriginalVisibility(true), toast });
  StorageManager.init({ toast });
  PaperOverview.init();
  $("btnPaperOverview").addEventListener("click", () => PaperOverview.open(cur(), loadSettings, readOverviewSource, openSettings));
  ReaderChrome.init();
  // 上传 / 拖拽
  $("dropZone").addEventListener("click", () => $("fileInput").click());
  $("btnLibraryAdd").addEventListener("click", () => $("fileInput").click());
  $("btnLibrarySearch").addEventListener("click", () => PaperLibrary.focusSearch());
  $("btnLibrarySettings").addEventListener("click", openSettings);
  // Keep the floating results below the toolbar when controls wrap on a small window.
  const toolbarResize = new ResizeObserver(() => {
    if (!$("app").classList.contains("hidden")) document.documentElement.style.setProperty("--search-panel-top", ($("topbar").getBoundingClientRect().bottom + 8) + "px");
  });
  toolbarResize.observe($("topbar"));
  $("fileInput").addEventListener("change", (e) => { handleFiles(e.target.files); e.target.value = ""; });
  $("btnOpen").addEventListener("click", () => $("fileInput").click());
  $("btnLibrary").addEventListener("click", showLibrary);
  ["dragenter", "dragover"].forEach((ev) =>
    document.addEventListener(ev, (e) => { e.preventDefault(); $("dropZone").classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) =>
    document.addEventListener(ev, (e) => { e.preventDefault(); $("dropZone").classList.remove("over"); }));
  document.addEventListener("drop", (e) => {
    if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
  });

  // 视图切换
  document.querySelectorAll("#viewSeg .v").forEach((b) => {
    b.addEventListener("click", () => selectReaderView(b.dataset.view));
  });
  for (const button of $("readerFlowOptions").querySelectorAll("button")) {
    button.addEventListener("click", () => applyMode(button.dataset.flow));
  }
  const viewMenu = $("readerViewMenu");
  const viewMenuTrigger = viewMenu.querySelector("summary");
  $("btnHideToolbar").addEventListener("click", () => $("btnReaderChrome").click());
  viewMenu.addEventListener("click", (event) => {
    const button = event.target.closest(".reader-menu-action");
    if (!button) return;
    if (viewMenu.contains(document.activeElement)) viewMenuTrigger.focus();
    viewMenu.open = false;
  });
  document.addEventListener("pointerdown", (event) => {
    if (viewMenu.open && !viewMenu.contains(event.target)) viewMenu.open = false;
  });
  viewMenu.addEventListener("keydown", (event) => {
    if (viewMenu.open && event.key === "Escape") {
      event.stopPropagation();
      viewMenu.open = false;
      viewMenuTrigger.focus();
    }
  });

  // 缩放
  $("btnZoomIn").addEventListener("click", () => zoomBy(1.2));
  $("btnZoomOut").addEventListener("click", () => zoomBy(1 / 1.2));
  $("btnFitWidth").addEventListener("click", () => {
    const d = cur(); if (!d) return;
    if (state.mode === "duo") {
      fitDuoWidth(d.duoZoomTarget);
      return;
    }
    d.fitWidth = true; d.scale = fitWidthScale(d); onScaleChange();
  });
  $("duoZoomTarget").addEventListener("change", (event) => setDuoZoomTarget(event.target.value));
  $("btnDuoSync").addEventListener("click", () => {
    const d = cur();
    if (!d || !d.duoShowOriginal) return;
    d.duoSync = !d.duoSync;
    updateZoomLabel();
    if (d.duoSync) syncDuoScroll(d.duoZoomTarget);
    persistCurrentProgress();
  });
  document.querySelectorAll(".duo-pane").forEach((pane) => {
    const side = pane.dataset.duoSide;
    for (const event of ["pointerdown", "focusin"]) {
      pane.addEventListener(event, () => setDuoZoomTarget(side));
    }
    pane.querySelector(".duo-scroll").addEventListener("scroll", () => syncDuoScroll(side, true), { passive: true });
  });
  $("viewer").addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const side = e.target.closest(".duo-pane");
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    if (state.mode === "duo" && side) zoomDuoBy(side.dataset.duoSide, factor);
    else zoomBy(factor);
  }, { passive: false });
  // 侧栏伸缩和窗口尺寸变化只更新处于“适应宽度”的一侧，保留手动倍率。
  const duoResize = new ResizeObserver(throttle(() => {
    if (cur() && state.mode === "duo" && !$("app").classList.contains("hidden")) renderDuo();
  }, 200));
  duoResize.observe(document.querySelector(".duo-body"));
  // 翻页
  $("btnPrev").addEventListener("click", () => goToPage(cur() ? cur().currentPage - 1 : 1));
  $("btnNext").addEventListener("click", () => goToPage(cur() ? cur().currentPage + 1 : 1));
  $("pageInput").addEventListener("change", (e) => {
    const d = cur();
    if (!d) return;
    const n = Number.parseInt(e.target.value, 10);
    const page = Number.isFinite(n) ? Math.min(d.pagesMeta.length, Math.max(1, n)) : d.currentPage;
    e.target.value = page;
    if (page !== d.currentPage) goToPage(page);
  });

  // 侧栏
  const syncSidebarToggle = () => {
    const collapsed = $("sidebar").classList.contains("collapsed");
    $("btnSidebar").setAttribute("aria-expanded", String(!collapsed));
    $("btnSidebar").setAttribute("aria-controls", "sidebarContent");
    $("btnSidebar").setAttribute("aria-label", collapsed ? "展开文档导航" : "收起文档导航");
    $("btnSidebar").title = collapsed ? "展开文档导航" : "收起文档导航";
    $("sidebarContent").inert = collapsed;
    syncDockedNavigation();
  };
  const setSidebarCollapsed = (collapsed) => {
    $("sidebar").classList.toggle("collapsed", collapsed);
    syncSidebarToggle();
  };
  syncSidebarToggle();
  $("btnSidebar").addEventListener("click", () => {
    setSidebarCollapsed(!$("sidebar").classList.contains("collapsed"));
  });
  document.querySelectorAll(".shead .s").forEach((s) => {
    s.addEventListener("click", () => switchSidebar(s.dataset.tab));
  });

  // 搜索
  $("btnDocumentSearch").addEventListener("click", openSearch);
  $("btnSearchClose").addEventListener("click", closeSearch);
  $("btnSearchNext").addEventListener("click", () => nextMatch(false));
  $("btnSearchPrev").addEventListener("click", () => nextMatch(true));
  $("searchInput").addEventListener("input", throttle((e) => {
    if (!$("searchBox").classList.contains("hidden")) runSearch(e.target.value);
  }, 220));
  $("searchScope").addEventListener("change", (event) => {
    if (!cur()) return;
    cur().searchScope = event.target.value;
    runSearch($("searchInput").value);
  });
  $("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); nextMatch(e.shiftKey); }
    if (e.key === "ArrowDown" && cur()?.searchResults.length) {
      e.preventDefault();
      switchSidebar("search");
      $("searchPanel").querySelector(".sres.active")?.focus();
    }
    if (e.key === "Escape") closeSearch();
  });

  // 设置
  $("btnSettings").addEventListener("click", openSettings);
  $("btnCloseSettings").addEventListener("click", closeSettings);
  $("btnCancelSettings").addEventListener("click", closeSettings);
  $("btnTestConnection").addEventListener("click", testConnection);
  $("translationPromptSettings").addEventListener("toggle", (event) => {
    if (event.target.open && !$("settingsModal").classList.contains("hidden")) {
      showDefaultTranslationPrompt();
      event.target.scrollIntoView({ block: "nearest" });
    }
  });
  $("setTranslationPrompt").addEventListener("input", (event) => { event.target.dataset.edited = "true"; });
  $("btnResetTranslationPrompt").addEventListener("click", () => {
    $("setTranslationPrompt").value = defaultTranslationPrompt;
    $("setTranslationPrompt").focus({ preventScroll: true });
    resetConnectionCheck();
  });
  $("settingsModal").addEventListener("input", resetConnectionCheck);
  $("btnSaveSettings").addEventListener("click", () => {
    const before = loadSettings();
    try {
      saveSettings(readSettingsForm());
    } catch (_) {
      $("connectionStatus").textContent = "设置未能保存，请检查本机存储。";
      $("connectionStatus").dataset.result = "error";
      return;
    }
    const after = loadSettings();
    const outputChanged = ["model", "base_url", "target", "translation_prompt"].some((key) => before[key] !== after[key]);
    const connectionChanged = outputChanged || before.api_key !== after.api_key || before.temperature !== after.temperature;
    if (connectionChanged) {
      translationGeneration++;
      for (const doc of state.tabs) {
        doc.translationErrors = {};
        doc.translationChecked.clear();
        if (outputChanged) doc.translations = {};
      }
      const d = cur();
      if (outputChanged && d?.searchScope === "translation" && d.searchQuery) runSearch(d.searchQuery);
    }
    closeSettings();
    if (cur() && state.mode === "duo") { ensureDuoWindow(); renderDuo(); }
    toast("设置已保存");
  });
  $("btnShowKey").addEventListener("click", () => {
    const el = $("setApiKey");
    el.type = el.type === "password" ? "text" : "password";
    $("btnShowKey").textContent = el.type === "password" ? "显示" : "隐藏";
  });
  $("btnOpenStorageFromSettings").addEventListener("click", () => {
    const focusTarget = settingsReturnFocus;
    closeSettings();
    StorageManager.open(focusTarget);
  });
  $("settingsModal").addEventListener("click", (e) => { if (e.target === $("settingsModal")) closeSettings(); });

  // 连续滚动
  $("continuousView").addEventListener("scroll", throttle(() => {
    if (state.mode !== "continuous" || $("app").classList.contains("hidden")) return;
    renderVisible();
    if (!cur()?.restoring) { updateCurrentFromScroll(); persistCurrentProgress(); }
  }, 200));
  for (const id of ["singleView", "duoOriginalScroll", "duoTranslationScroll"]) {
    $(id).addEventListener("scroll", throttle(persistCurrentProgress, 200));
  }
  for (const type of ["pointerdown", "wheel", "keydown"]) document.addEventListener(type, (e) => {
    if (!cur() || $("app").classList.contains("hidden") || !e.isTrusted) return;
    cur().lastReadActivity = Date.now();
    if (type === "wheel" || e.target.closest(".duo-scroll")) cur().lateTranslationAnchor = null;
  }, { capture: true, passive: true });

  // 键盘
  document.addEventListener("keydown", (e) => {
    if ($("paperOverview").open) return;
    if (isMac && e.metaKey && !e.altKey && !e.shiftKey && !e.defaultPrevented) {
      const command = { o: "open", w: "close", ",": "settings" }[e.key.toLowerCase()];
      if (command) {
        if (command !== "close" || (cur() && !$("app").classList.contains("hidden"))) {
          e.preventDefault();
          window.folioMenuCommand(command);
          return;
        }
      }
    }
    if (!$("settingsModal").classList.contains("hidden")) {
      handleSettingsKeydown(e);
      return;
    }
    if (e.defaultPrevented) return;
    const tag = e.target.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      if ($("app").classList.contains("hidden")) PaperLibrary.focusSearch(); else openSearch();
      return;
    }
    if (e.key === "Escape") {
      if (!$("searchBox").classList.contains("hidden")) closeSearch();
      return;
    }
    if (typing) return;
    if (e.shiftKey && readerNotes.hasSelectionWithin($("viewer"))) return;
    const d = cur();
    if (!d || $("app").classList.contains("hidden")) return;
    switch (e.key) {
      case "ArrowRight": case "PageDown": e.preventDefault(); goToPage(d.currentPage + 1); break;
      case "ArrowLeft": case "PageUp": e.preventDefault(); goToPage(d.currentPage - 1); break;
      case "Home": goToPage(1); break;
      case "End": goToPage(d.pagesMeta.length); break;
      case "+": case "=": zoomBy(1.2); break;
      case "-": zoomBy(1 / 1.2); break;
    }
  });

  let fitResizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(fitResizeTimer);
    fitResizeTimer = setTimeout(() => {
      const d = cur();
      if (!d || d.restoring || $("app").classList.contains("hidden") || state.mode === "duo") return;
      const scale = fitWidthScale(d);
      if (d.fitWidth && Math.abs(scale - d.scale) > 0.005) {
        persistCurrentProgress();
        d.pendingRestore = { ...d.reading };
        d.restoring = true;
        d.scale = scale;
        updateZoomLabel();
        if (state.mode === "continuous") {
          buildSlots();
          restoreReadingPosition(d);
        } else renderSingle();
      } else if (state.mode === "continuous") renderVisible();
    }, reduceMotion.matches ? 0 : 85);
  }).observe($("viewer"));

  const saveOnExit = () => { persistCurrentProgress(); PaperLibrary.flush(true); };
  window.addEventListener("pagehide", saveOnExit);
  document.addEventListener("visibilitychange", () => { if (document.hidden) saveOnExit(); });

  // 全局错误提示
  window.addEventListener("error", (e) => { try { toast("JS 错误：" + (e.message || e.type), 8000); } catch (err) {} });
  window.addEventListener("unhandledrejection", (e) => {
    const m = e && e.reason && (e.reason.message || String(e.reason));
    try { toast("异步错误：" + (m || "未知"), 8000); } catch (err) {}
  });

  await PaperLibrary.init({ open: reopenDoc, toast });

  // 深链：?open=<hash>&[mode=duo|single] —— 重新打开已上传文档（调试/分享用）
  const q = new URLSearchParams(location.search);
  const openHash = q.get("open");
  if (openHash) {
    (async () => {
      try {
        await reopenDoc(openHash);
        const m = q.get("mode");
        if (m === "duo" || m === "single" || m === "continuous") await applyMode(m);
        const pg = parseInt(q.get("page"), 10);
        if (pg >= 1) goToPage(pg);
      } catch (e) { console.error(e); }
    })();
  }
}

window.addEventListener("DOMContentLoaded", init);
