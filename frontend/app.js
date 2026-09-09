/* 阅屿 · Folio（阅读为主，翻译为辅助）；旧存储键保持不变以兼容历史数据。 */
"use strict";

const $ = (id) => document.getElementById(id);
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
  model: "deepseek-chat",
  base_url: "https://api.deepseek.com",
  target: "简体中文",
  temperature: 0.3,
};

const cur = () => state.tabs[state.active];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= 工具 ================= */
function loadSettings() {
  try { return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem("paper-reader-settings") || "{}")); }
  catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
}
function saveSettings(s) { localStorage.setItem("paper-reader-settings", JSON.stringify(s)); }

let toastTimer = null;
function toast(msg, ms) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), ms || 4000);
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
    scale: null, duoScale: null, currentPage: 1, mode: "continuous", fitWidth: true,
    reading: PaperLibrary.get(id)?.reading || null, restoring: false, pendingRestore: null,
    duoOriginalScale: null, duoShowOriginal: true,
    duoFitOriginal: true, duoFitTranslation: true, duoZoomTarget: "translation",
    translations: {}, translationErrors: {}, inFlight: new Set(), queue: [],
    renderToken: 0,
    slots: null, thumbs: null,
    searchResults: [], searchIdx: -1, searchMatch: null, searchQuery: "", searchLoading: false,
  };
  state.tabs.push(tab);
  return tab;
}

function renderTabsBar() {
  const el = $("tabs");
  el.innerHTML = "";
  state.tabs.forEach((t, i) => {
    const tab = document.createElement("div");
    tab.className = "tab" + (i === state.active ? " active" : "");
    const name = document.createElement("span");
    name.className = "tname"; name.textContent = t.name; name.title = t.name;
    const x = document.createElement("span");
    x.className = "x"; x.textContent = "×"; x.title = "关闭";
    tab.appendChild(name); tab.appendChild(x);
    tab.addEventListener("click", (e) => { e.stopPropagation(); activateTab(i); });
    x.addEventListener("click", (e) => { e.stopPropagation(); closeTab(i); });
    el.appendChild(tab);
  });
}

async function activateTab(idx) {
  if (idx < 0 || idx >= state.tabs.length) return;
  if (idx === state.active && !$("app").classList.contains("hidden")) return;
  // 切换前保存当前进度
  if (state.active >= 0 && state.active !== idx) persistCurrentProgress();
  searchRun++;
  if (cur()) cur().searchLoading = false;
  readerSearch.cancelJump();
  readerSearch.detach($("duoOrig").parentElement);
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
    for (const key of ["mode", "scale", "fitWidth", "duoScale", "duoOriginalScale", "duoFitOriginal", "duoFitTranslation", "duoShowOriginal"]) {
      if (prog[key] !== undefined) d[key] = prog[key];
    }
  }
  $("searchInput").value = d.searchQuery;
  if (d.searchQuery) $("searchBox").classList.remove("hidden");
  $("btnDocumentSearch").setAttribute("aria-expanded", String(!$("searchBox").classList.contains("hidden")));
  renderSearchPanel();
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
    readerSearch.detach($("duoOrig").parentElement);
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
  const reading = { ...(d.reading || {}), page: d.currentPage, mode: state.mode };
  delete reading.legacyScrollTop;
  for (const key of ["scale", "duoScale", "duoOriginalScale"]) reading[key] = d[key] || 1;
  for (const key of ["fitWidth", "duoFitOriginal", "duoFitTranslation", "duoShowOriginal"]) reading[key] = d[key];
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
  toast("正在解析 PDF…", 2500);
  try {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/parse", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || ("解析失败 " + res.status));
    PaperLibrary.register(data, data.pdf_hash, data.file_name || file.name, data.pages.length);
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
  toast("正在打开…", 2500);
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
const duoPaint = { original: null, translation: null };

function cancelDuoRender() {
  if (!duoRenderJob) return;
  for (const task of duoRenderJob.tasks) task.cancel();
  duoRenderJob = null;
}

function sameDuoPaint(a, b) {
  return a && a.doc === b.doc && a.page === b.page && a.scale === b.scale &&
    a.dpr === b.dpr && a.revision === b.revision;
}

function publishDuoCanvas(side, source, vp, info, draw) {
  const original = side === "original";
  const canvas = $(original ? "duoOrig" : "duoTrans");
  const scroller = $(original ? "duoOriginalScroll" : "duoTranslationScroll");
  const previous = duoPaint[side];
  const samePage = previous && previous.doc === info.doc && previous.page === info.page;
  const ratio = samePage ? info.scale / previous.scale : 1;
  const left = samePage && scroller.scrollLeft > 0 ? (scroller.scrollLeft + scroller.clientWidth / 2) * ratio - scroller.clientWidth / 2 : 0;
  const top = samePage && scroller.scrollTop > 0 ? (scroller.scrollTop + scroller.clientHeight / 2) * ratio - scroller.clientHeight / 2 : 0;
  canvas.width = source.width; canvas.height = source.height;
  canvas.style.width = Math.ceil(vp.width / info.dpr) + "px";
  canvas.style.height = Math.ceil(vp.height / info.dpr) + "px";
  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, 0, 0);
  draw(ctx);
  scroller.scrollLeft = left;
  scroller.scrollTop = top;
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
}

async function renderDuo() {
  const d = cur(); if (!d || state.mode !== "duo" || $("app").classList.contains("hidden")) return;
  syncDuoControls(d);
  readerSearch.refresh(d);
  cancelDuoRender();
  const idx = d.currentPage - 1;
  const meta = d.pagesMeta[idx];
  const tr = d.translations[idx];
  updateTranslationNotice(d);
  const original = { doc: d, page: idx, scale: d.duoOriginalScale, dpr: state.dpr,
    revision: null };
  const translated = { doc: d, page: idx, scale: d.duoScale, dpr: state.dpr,
    revision: tr || (d.inFlight.has(idx) ? "loading" : d.translationErrors[idx] ? "failed" : "empty") };
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
      publishDuoCanvas("original", source.canvas, source.vp, original, () => {});
      await readerSearch.mountOriginal($("duoOrig").parentElement, d, page, page.getViewport({ scale: original.scale }));
      if (!active()) return;
    }
    if (needTranslation) {
      // 公式/图表裁取始终使用译文倍率的原始 PDF，不依赖左侧是否显示或左侧倍率。
      if (!source || original.scale !== translated.scale) source = await raster(translated.scale);
      if (!active()) return;
      publishDuoCanvas("translation", source.canvas, source.vp, translated, (ctx) => {
        if (tr) {
          const map = {};
          tr.blocks.forEach((b) => { map[b.id] = b.rich_text !== undefined ? b.rich_text : b.text; });
          (tr.failed_blocks || []).forEach((b) => { map[b.id] = "〔此段翻译未完成，请重试〕"; });
          reflowPage(ctx, source.canvas, meta, map, source.vp, translated.scale, state.dpr);
        } else {
          ctx.fillStyle = "rgba(255,255,255,0.55)";
          ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
          ctx.fillStyle = "#475569";
          ctx.font = (15 * state.dpr) + "px 'Microsoft YaHei', sans-serif";
          const msg = translated.revision === "loading" ? "翻译中…" : translated.revision === "failed" ? "翻译未完成，请重试" : "尚未翻译";
          ctx.fillText(msg, (ctx.canvas.width - ctx.measureText(msg).width) / 2, ctx.canvas.height / 2);
        }
      });
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

// 文字和公式共享行盒：公式有真实宽度、基线上方高度和基线下方高度。
// 原图只在绘制时裁取；缩放页面后会使用 PDF.js 新渲染的高分辨率原图。
function layoutInlineText(ctx, text, block, fs, maxW, firstIndent, meta, vp) {
  const formulas = new Map((block.inline_math || []).map((m) => [m.token, m]));
  const units = [];
  const tokenRe = /__MATH_\d{4,}__/g;
  let pos = 0, match;
  const pushText = (value) => {
    for (const atom of textLayoutUnits(value, ctx, maxW)) units.push({ type: "text", text: atom });
  };
  while ((match = tokenRe.exec(String(text))) !== null) {
    pushText(String(text).slice(pos, match.index));
    const m = formulas.get(match[0]);
    if (!m || !m.bbox || !(m.font_size > 0)) {
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
    units.push({ type: "math", token: m.token, slices, padding,
      width: imageW * fit + padding * 2, imageW: imageW * fit, imageH: imageH * fit,
      ascent: Math.max(0, ascent * fit), descent: Math.max(0, descent * fit) });
    pos = match.index + match[0].length;
  }
  pushText(String(text).slice(pos));
  const lines = [];
  const newLine = (indent) => ({ runs: [], width: 0, indent, ascent: fs * 0.85, descent: fs * 0.35 });
  let line = newLine(firstIndent || 0);
  const finishLine = () => {
    const last = line.runs[line.runs.length - 1];
    if (last && last.type === "text") {
      last.text = last.text.trimEnd();
      const width = ctx.measureText(last.text).width;
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
      : last && last.type === "text" ? ctx.measureText(last.text + unit.text).width - last.width
      : ctx.measureText(unit.text).width;
    let delta = addedWidth();
    if (line.width + delta > maxW - line.indent && line.runs.length) {
      finishLine(); last = null; delta = addedWidth();
      if (unit.type === "text" && !unit.text.trim()) continue;
    }
    if (!line.runs.length && delta > maxW - line.indent) line.indent = 0;
    if (unit.type === "text" && last && last.type === "text") {
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
  return lines;
}

function drawInlineLine(ctx, line, x, baseline, src) {
  let cursor = x;
  for (const run of line.runs) {
    if (run.type === "math") {
      for (const slice of run.slices) {
        const r = slice.crop;
        ctx.drawImage(src, r.x, r.y, r.w, r.h,
          cursor + run.padding + slice.x, baseline + slice.y, slice.w, slice.h);
      }
    } else if (run.text.trim()) {
      ctx.fillText(run.text, cursor, baseline);
    }
    cursor += run.width;
  }
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
  if (!lc) return rc ? [rc] : [mk(body)];
  if (!rc) return [lc];
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

// 首页页眉按原始纵向位置居中绘制；译文换行时向下扩展，但不侵入摘要区。
function drawCoverHeader(ctx, blocks, map, meta, vp, scale, dpr, fam, src, measureOnly) {
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
    const rich = !!(b.inline_math && b.inline_math.length);
    const lines = rich ? layoutInlineText(ctx, text, b, fs, maxW, 0, meta, vp)
      : wrapText(ctx, String(text), fs, maxW, 0);
    let baseline = top + fs;
    let previousBottom = top;
    for (const line of lines) {
      if (rich) baseline = Math.max(baseline, previousBottom + line.ascent);
      const x = centerX - (rich ? line.width : ctx.measureText(line).width) / 2;
      if (!measureOnly) {
        if (rich) drawInlineLine(ctx, line, x, baseline, src);
        else ctx.fillText(line, x, baseline);
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
  if (!cols.length && !coverHeader.length) return;
  const hasInlineMath = meta.blocks.some((b) => !b.math && !b.skip && b.inline_math && b.inline_math.length);
  const allowOverflow = hasInlineMath || equations.length > 0;
  const headerBottom = drawCoverHeader(ctx, coverHeader, map, meta, vp, scale, dpr, fam, src, true);
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
      obstacles, meta, src, vp, true, true);
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
  // 高公式增大局部行高时不能再截断页底。先测量，再扩展译文画布；原文页不变。
  if (allowOverflow) {
    let neededHeight = Math.max(src.height, leadBottom);
    for (const f of flows) {
      const bottom = flowColumn(ctx, f.colRect, f.col.blocks, map, bodyFs, fam, scale, dpr,
        f.obstacles, meta, src, vp, true, true);
      neededHeight = Math.max(neededHeight, bottom + 12 * scale * dpr);
    }
    if (neededHeight > ctx.canvas.height) {
      ctx.canvas.height = Math.ceil(neededHeight);
      if (ctx.canvas.style) ctx.canvas.style.height = Math.ceil(neededHeight / dpr) + "px";
    }
  }
  // 1) 整页填白，擦除所有原文（节编号、被丢弃块等一并清除）
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
  // 2) 贴回所有「不翻译」的内容：保护区 + math/skip 块（公式/表格/引用/图注原样）
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
  drawCoverHeader(ctx, coverHeader, map, meta, vp, scale, dpr, fam, src, false);
  // 4) 双栏之前的跨栏导语按原始宽度排版
  for (const f of spanningFlows) {
    flowColumn(ctx, f.rect, [f.block], map, bodyFs, fam, scale, dpr,
      f.obstacles, meta, src, vp, false, true);
  }
  // 5) 各栏流动排版译文（避开保护区块）
  for (const f of flows) {
    flowColumn(ctx, f.colRect, f.col.blocks, map, bodyFs, fam, scale, dpr,
      f.obstacles, meta, src, vp, false, allowOverflow);
  }
}

// 单栏流动排版：逐行写入译文，遇到保护区整体下移到其下方，保证不重叠、不截断
function flowColumn(ctx, colRect, blocks, map, bodyFs, fam, scale, dpr, obstacles, meta, src, vp, measureOnly, allowOverflow) {
  const fs0 = bodyFs * scale * dpr;
  let y = colRect.y + fs0 * 0.9;
  let previousBottom = null;
  const maxBottom = (meta.height - 12) * scale * dpr;
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
      if (!measureOnly) ctx.drawImage(src, r.x, r.y, r.w, r.h, x, top, w, h);
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
    const rich = !!(b.inline_math && b.inline_math.length);
    let lines = rich ? layoutInlineText(ctx, text, b, fs, colRect.w, 0, meta, vp)
      : wrapText(ctx, String(text), fs, colRect.w, 0);
    const citationContinuation = /^\s*(?:18|19|20)\d{2}[a-z]?\s*[;,)；，）]/.test(b.text || "");
    const indent = (!isHeading && lines.length > 1 && !citationContinuation) ? fs * 2 : 0;
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
      if (!allowOverflow && bot > maxBottom) break;
      if (!measureOnly) {
        if (rich) drawInlineLine(ctx, lines[i], colRect.x + lines[i].indent, y, src);
        else ctx.fillText(lines[i], colRect.x + (i === 0 ? lines.firstIndent : 0), y);
      }
      previousBottom = bot;
      y += lh;
    }
    y += fs * 0.35; // 段间距
    if (!allowOverflow && y > maxBottom) break;
  }
  return Math.max(y, previousBottom || colRect.y);
}

/* ================= 页级滑动窗口翻译 ================= */
let workerCount = 0;

async function ensureDuoWindow() {
  const d = cur(); if (!d) return;
  if (!loadSettings().api_key.trim()) {
    openSettings();
    toast("请先填写 DeepSeek API Key");
    return;
  }
  const total = d.pagesMeta.length;
  const center = d.currentPage - 1;
  const want = [];
  for (let p = center - 3; p <= center + 3; p++) {
    if (p >= 0 && p < total && d.pagesMeta[p].blocks.length) want.push(p);
  }
  const pending = want.filter((p) => !d.translations[p] && !d.translationErrors[p] && !d.inFlight.has(p));
  if (pending.length) {
    pending.forEach((p) => d.inFlight.add(p));
    d.queue.push(...pending);
    runWorkers();
  }
  updateDuoStatus(want.length);
}

function runWorkers() {
  const d = cur(); if (!d) return;
  while (workerCount < 3 && d.queue.length) {
    const p = d.queue.shift();
    workerCount++;
    translateOne(d, p).finally(() => { workerCount--; runWorkers(); });
  }
}

async function translateOne(d, p) {
  const settings = loadSettings();
  let ok = false;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("/api/translate_page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdf_hash: d.id, page: p, settings }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.complete === false) {
        if (data.code === "translation_incomplete") {
          // The backend has already retried each failed segment. Retain partial
          // progress and wait for an explicit retry instead of looping on scroll.
          if (data.blocks?.length) d.translations[p] = data;
          d.translationErrors[p] = data;
          break;
        }
        const error = new Error(typeof data.detail === "string" ? data.detail : `翻译请求失败（HTTP ${res.status}）`);
        error.retryable = res.status === 429 || res.status >= 500;
        throw error;
      }
      d.translations[p] = data;
      delete d.translationErrors[p];
      ok = true;
      break;
    } catch (e) {
      lastErr = e;
      if (e.retryable === false) break;
      if (attempt < 2) await sleep(1500 * (attempt + 1));
    }
  }
  d.inFlight.delete(p);
  if (!ok && !d.translationErrors[p]) d.translationErrors[p] = {
    detail: lastErr?.message || "翻译未完成，请重试", code: "request_failed",
  };
  if (cur() === d && state.mode === "duo") {
    if (d.currentPage - 1 === p) renderDuo();
    updateDuoStatus();
  }
}

function updateTranslationNotice(d) {
  const p = d.currentPage - 1;
  const error = d.translationErrors[p];
  $("translationNotice").classList.toggle("hidden", !error);
  if (!error) return;
  const busy = d.inFlight.has(p);
  $("translationMessage").textContent = busy ? "正在重试未完成段落，已成功的译文会保留…" : error.detail;
  $("btnRetryTranslation").disabled = busy;
  $("btnRetryTranslation").textContent = busy ? "重试中…" : "重试未完成段落";
}

$("btnRetryTranslation").onclick = () => {
  const d = cur(); if (!d) return;
  const p = d.currentPage - 1;
  if (d.inFlight.has(p)) return;
  if (!loadSettings().api_key.trim()) { openSettings(); return; }
  d.inFlight.add(p);
  d.queue.unshift(p);
  updateTranslationNotice(d);
  runWorkers();
};

function updateDuoStatus(totalHint) {
  // 「已缓存 x/x 页」UI 已移除，不再显示；此处保留为 no-op，避免改动其它调用方。
  const el = $("duoStatus");
  if (!el) return;
  const d = cur(); if (!d) return;
  const center = d.currentPage - 1;
  let done = 0, total = 0;
  for (let p = center - 3; p <= center + 3; p++) {
    if (p < 0 || p >= d.pagesMeta.length || !d.pagesMeta[p].blocks.length) continue;
    total++;
    if (d.translations[p]) done++;
  }
  if (total === 0) { el.textContent = ""; return; }
  if (done >= total) el.textContent = "已缓存 " + done + "/" + total + " 页";
  else el.textContent = "已缓存 " + done + "/" + total + " 页 · 后台翻译中…";
}

/* ================= 视图模式 ================= */
function fitDuoScale(d, side) {
  const meta = d.pagesMeta[d.currentPage - 1] || d.pagesMeta[0];
  if (!meta) return 1;
  const scroller = $(side === "original" ? "duoOriginalScroll" : "duoTranslationScroll");
  const style = getComputedStyle(scroller);
  const avail = scroller.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  return Math.max(0.25, Math.min(4, avail / meta.width));
}

function syncDuoControls(d) {
  $("duoOriginalPane").classList.toggle("hidden", !d.duoShowOriginal);
  $("btnToggleOriginal").textContent = d.duoShowOriginal ? "隐藏原文" : "显示原文";
  $("btnToggleOriginal").setAttribute("aria-expanded", String(d.duoShowOriginal));
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

function toggleDuoOriginal() {
  const d = cur(); if (!d || state.mode !== "duo") return;
  persistCurrentProgress();
  d.duoShowOriginal = !d.duoShowOriginal;
  if (!d.duoShowOriginal && d.reading?.original) d.hiddenOriginalAnchor = { page: d.currentPage, anchor: d.reading.original };
  if (!d.duoShowOriginal) d.duoZoomTarget = "translation";
  renderDuo().then(persistCurrentProgress);
}

function updateZoomLabel() {
  const d = cur(); if (!d) return;
  const s = state.mode === "duo" ? (d.duoScale || d.scale) : d.scale;
  $("zoomVal").textContent = Math.round(s * 100) + "%";
  $("btnFitWidth").setAttribute("aria-pressed", String(d.fitWidth));
  for (const [prefix, scale, fit] of [
    ["Orig", d.duoOriginalScale, d.duoFitOriginal], ["Trans", d.duoScale, d.duoFitTranslation],
  ]) {
    $(prefix === "Orig" ? "origZoomVal" : "transZoomVal").textContent = Math.round((scale || 1) * 100) + "%";
    $("btn" + prefix + "Fit").setAttribute("aria-pressed", String(fit));
    $("btn" + prefix + "ZoomOut").disabled = scale <= 0.25;
    $("btn" + prefix + "ZoomIn").disabled = scale >= 4;
  }
}

function applyMode(mode, restoring = false) {
  if (!["continuous", "single", "duo"].includes(mode)) return;
  if (!restoring) {
    persistCurrentProgress();
    if (cur()) { cur().pendingRestore = null; cur().restoring = false; cur().lateTranslationAnchor = null; cur().hiddenOriginalAnchor = null; }
  }
  readerNotes.clearSelection();
  if (mode !== "single") cancelSingleRender();
  if (mode !== "duo") cancelDuoRender();
  state.mode = mode;
  document.querySelectorAll("#viewSeg .v").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("viewSeg").dataset.activeMode = mode;
  document.querySelectorAll("#viewSeg .v").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  $("continuousView").classList.toggle("hidden", mode !== "continuous");
  $("singleView").classList.toggle("hidden", mode !== "single");
  $("duoView").classList.toggle("hidden", mode !== "duo");
  $("zoomControls").classList.toggle("hidden", mode === "duo");
  readerNotes.sync();
  const d = cur();
  if (!d) return;
  d.mode = mode;
  updateZoomLabel();
  let rendered;
  if (mode === "continuous") {
    if (restoring) restoreReadingPosition(d);
    else { scrollToPage(d.currentPage); renderVisible(); }
  }
  else if (mode === "single") rendered = renderSingle();
  else if (mode === "duo") { rendered = renderDuo(); ensureDuoWindow(); }
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
  else if (state.mode === "single") renderSingle().then(persistCurrentProgress);
  else if (state.mode === "duo") { renderDuo().then(persistCurrentProgress); ensureDuoWindow(); }
  if (state.mode === "continuous") persistCurrentProgress();
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
}

/* ================= 全文搜索 ================= */
let searchRun = 0;

function openSearch() {
  $("searchBox").classList.remove("hidden");
  $("btnDocumentSearch").setAttribute("aria-expanded", "true");
  $("searchInput").focus();
  $("searchInput").select();
}

function closeSearch() {
  searchRun++;
  const restoreFocus = $("searchBox").contains(document.activeElement);
  $("searchBox").classList.add("hidden");
  $("btnDocumentSearch").setAttribute("aria-expanded", "false");
  $("searchPanel").classList.add("hidden");
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
  const active = () => token === searchRun && cur() === d;
  try {
    const results = await readerSearch.find(d, q, active);
    if (!active()) return;
    d.searchResults = results; d.searchLoading = false;
    d.searchIdx = results.length ? 0 : -1;
    renderSearchPanel();
    if (results.length) goToMatch(0);
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
  if (!d || !d.searchResults.length || $("searchBox").classList.contains("hidden")) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    $("searchCount").textContent = d && d.searchLoading ? "搜索中…" : d && d.searchQuery ? "0/0" : "";
    return;
  }
  $("searchCount").textContent = (d.searchIdx + 1) + "/" + d.searchResults.length;
  panel.classList.remove("hidden");
  panel.innerHTML = "";
  d.searchResults.forEach((r, k) => {
    const b = document.createElement("button");
    b.className = "sres" + (k === d.searchIdx ? " active" : "");
    b.innerHTML = '<span class="spg">p' + (r.page + 1) + '</span><span class="stxt">' + buildSnippet(r.text, r.idx, r.end - r.start) + "</span>";
    b.addEventListener("click", () => goToMatch(k));
    panel.appendChild(b);
  });
  const active = panel.querySelector(".sres.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function goToMatch(k) {
  const d = cur(); if (!d) return;
  if (!d.searchResults.length) return;
  k = (k + d.searchResults.length) % d.searchResults.length;
  d.searchIdx = k;
  const r = d.searchResults[k];
  d.searchMatch = r;
  goToPage(r.page + 1);
  readerSearch.select(d, r);
  renderSearchPanel();
}

function nextMatch(backward) {
  const d = cur(); if (!d || !d.searchResults.length) return;
  goToMatch(d.searchIdx + (backward ? -1 : 1));
}

/* ================= 设置 ================= */
let settingsReturnFocus = null;

function openSettings() {
  if ($("settingsModal").classList.contains("hidden")) settingsReturnFocus = document.activeElement;
  const s = loadSettings();
  $("setApiKey").value = s.api_key;
  $("setModel").value = s.model;
  $("setBaseUrl").value = s.base_url;
  $("setTarget").value = s.target;
  $("setTemperature").value = s.temperature;
  $("setApiKey").type = "password";
  $("btnShowKey").textContent = "显示";
  $("settingsModal").classList.remove("hidden");
  $("setApiKey").focus({ preventScroll: true });
}

function closeSettings() {
  if ($("settingsModal").classList.contains("hidden")) return;
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

/* ================= 初始化 ================= */
async function init() {
  readerNotes.init({ getDoc: cur, getMode: () => state.mode, goToPage, toast });
  StorageManager.init({ toast });
  // 上传 / 拖拽
  $("dropZone").addEventListener("click", () => $("fileInput").click());
  $("btnLibraryAdd").addEventListener("click", () => $("fileInput").click());
  $("btnLibrarySearch").addEventListener("click", () => $("librarySearch").focus());
  $("btnLibrarySettings").addEventListener("click", openSettings);
  // Keep the floating results below the toolbar when controls wrap on a small window.
  const toolbarResize = new ResizeObserver(() => {
    if (!$("app").classList.contains("hidden")) document.documentElement.style.setProperty("--search-panel-top", ($("topbar").getBoundingClientRect().bottom + 8) + "px");
  });
  toolbarResize.observe($("topbar"));
  $("fileInput").addEventListener("change", (e) => { handleFile(e.target.files[0]); e.target.value = ""; });
  $("btnOpen").addEventListener("click", () => $("fileInput").click());
  $("btnLibrary").addEventListener("click", showLibrary);
  ["dragenter", "dragover"].forEach((ev) =>
    document.addEventListener(ev, (e) => { e.preventDefault(); $("dropZone").classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) =>
    document.addEventListener(ev, (e) => { e.preventDefault(); $("dropZone").classList.remove("over"); }));
  document.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  // 视图切换
  document.querySelectorAll("#viewSeg .v").forEach((b) => {
    b.addEventListener("click", () => applyMode(b.dataset.mode));
  });

  // 缩放
  $("btnZoomIn").addEventListener("click", () => zoomBy(1.2));
  $("btnZoomOut").addEventListener("click", () => zoomBy(1 / 1.2));
  $("btnFitWidth").addEventListener("click", () => {
    const d = cur(); if (!d) return;
    d.fitWidth = true; d.scale = fitWidthScale(d); onScaleChange();
  });
  for (const [prefix, side] of [["Orig", "original"], ["Trans", "translation"]]) {
    $("btn" + prefix + "ZoomIn").addEventListener("click", () => zoomDuoBy(side, 1.2));
    $("btn" + prefix + "ZoomOut").addEventListener("click", () => zoomDuoBy(side, 1 / 1.2));
    $("btn" + prefix + "Fit").addEventListener("click", () => fitDuoWidth(side));
  }
  $("btnToggleOriginal").addEventListener("click", toggleDuoOriginal);
  document.querySelectorAll(".duo-pane").forEach((pane) => {
    for (const event of ["pointerdown", "focusin"]) {
      pane.addEventListener(event, () => { if (cur()) cur().duoZoomTarget = pane.dataset.duoSide; });
    }
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
    const n = parseInt(e.target.value, 10);
    if (Number.isFinite(n)) goToPage(n);
  });

  // 侧栏
  const syncSidebarToggle = () => {
    const collapsed = $("sidebar").classList.contains("collapsed");
    $("btnSidebar").setAttribute("aria-expanded", String(!collapsed));
    $("btnSidebar").setAttribute("aria-controls", "sidebar");
    $("btnSidebar").setAttribute("aria-label", collapsed ? "展开侧栏" : "收起侧栏");
    $("btnSidebar").title = collapsed ? "展开侧栏" : "收起侧栏";
    $("sidebar").inert = collapsed;
  };
  syncSidebarToggle();
  $("btnSidebar").addEventListener("click", () => {
    $("sidebar").classList.toggle("collapsed");
    syncSidebarToggle();
  });
  document.querySelectorAll(".shead .s").forEach((s) => {
    s.addEventListener("click", () => switchSidebar(s.dataset.tab));
  });

  // 搜索
  $("btnDocumentSearch").addEventListener("click", openSearch);
  $("btnSearchClose").addEventListener("click", closeSearch);
  $("btnSearchNext").addEventListener("click", () => nextMatch(false));
  $("btnSearchPrev").addEventListener("click", () => nextMatch(true));
  $("searchInput").addEventListener("input", throttle((e) => runSearch(e.target.value), 220));
  $("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); nextMatch(e.shiftKey); }
    if (e.key === "Escape") closeSearch();
  });

  // 设置
  $("btnSettings").addEventListener("click", openSettings);
  $("btnCloseSettings").addEventListener("click", closeSettings);
  $("btnCancelSettings").addEventListener("click", closeSettings);
  $("btnSaveSettings").addEventListener("click", () => {
    saveSettings({
      api_key: $("setApiKey").value.trim(),
      model: $("setModel").value,
      base_url: $("setBaseUrl").value.trim() || DEFAULT_SETTINGS.base_url,
      target: $("setTarget").value.trim() || DEFAULT_SETTINGS.target,
      temperature: Math.min(1, Math.max(0, Number($("setTemperature").value) || 0.3)),
    });
    closeSettings();
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
    if (!$("settingsModal").classList.contains("hidden")) {
      handleSettingsKeydown(e);
      return;
    }
    if (e.defaultPrevented) return;
    const tag = e.target.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      if ($("app").classList.contains("hidden")) $("librarySearch").focus(); else openSearch();
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

  window.addEventListener("resize", throttle(() => {
    const d = cur(); if (!d || d.restoring || $("app").classList.contains("hidden")) return;
    if (d.fitWidth && state.mode !== "duo") {
      persistCurrentProgress();
      d.pendingRestore = { ...d.reading }; d.restoring = true;
      d.scale = fitWidthScale(d); updateZoomLabel(); buildSlots();
      if (state.mode === "continuous") restoreReadingPosition(d); else renderSingle();
    } else if (state.mode === "continuous") renderVisible();
  }, 200));

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
