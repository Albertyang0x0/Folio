/* Local library transport and homepage. PDF rendering remains in app.js. */
"use strict";
const PaperLibrary = (() => {
  const records = new Map(), pending = new Map(), sending = new Map();
  const expandedGroups = new Set();
  const outboxKey = "paper-reader-library-outbox-v1";
  let timer, openPaper, notify, limit = 50, error = "", loading = true, homeScroll = 0, resumeHash = null;
  const el = (id) => document.getElementById(id);
  function readLocal(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch (_) { return fallback; } }
  const normalize = (s) => String(s || "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
  function matches(title, query) { const text = normalize(title); return normalize(query).split(" ").every((word) => text.includes(word)); }
  function sorted(items) { return items.sort((a, b) => Number(!!b.last_read) - Number(!!a.last_read) || b.last_read - a.last_read || b.imported_at - a.imported_at || a.hash.localeCompare(b.hash)); }
  function grouped(items) {
    const groups = new Map();
    for (const item of sorted([...items])) {
      // Never infer identity from the title alone, or replace a PDF's hash.
      const id = /^[a-f0-9]{64}$/.test(item.work_id || "") ? "work-" + item.work_id : "file-" + item.hash;
      if (!groups.has(id)) groups.set(id, { id, versions: [] });
      groups.get(id).versions.push(item);
    }
    return [...groups.values()].map((group) => ({ ...group,
      item: group.versions.find((item) => item.available !== false) || group.versions[0] }));
  }
  function timeLabel(stamp) {
    if (!stamp) return "尚未阅读";
    const date = new Date(stamp), today = new Date(), yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    const hhmm = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
    if (date.toDateString() === today.toDateString()) return "今天 " + hhmm;
    if (date.toDateString() === yesterday.toDateString()) return "昨天 " + hhmm;
    return date.getFullYear() + "/" + String(date.getMonth() + 1).padStart(2, "0") + "/" + String(date.getDate()).padStart(2, "0");
  }
  function status(message) {
    if (message !== undefined) error = message;
    const text = error || (loading ? "正在加载论文库…" : pending.size ? "正在保存阅读状态…" : "阅读记录保存在本机");
    el("libraryStatus").textContent = text;
    el("libraryRetry").classList.toggle("hidden", !error);
    // Normal saves are silent: scrolling must not resize or flash the toolbar.
    // Keep a visible recovery action only when something actually failed.
    el("readerSaveStatus").textContent = error ? "未保存 · 重试" : "";
    el("readerSaveStatus").title = error || "";
    el("readerSaveStatus").classList.toggle("hidden", !error);
  }
  function storeOutbox() {
    try { localStorage.setItem(outboxKey, JSON.stringify([...pending.values()])); }
    catch (_) { status("浏览器临时备份失败，正在尝试保存到本机"); }
  }
  async function request(path, body, keepalive = false) {
    const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive });
    if (!response.ok) throw new Error("论文库服务不可用，请确认后端已更新并重新启动");
    return response.json();
  }
  function accept(entry) {
    if (!entry) return;
    const current = records.get(entry.hash);
    // Metadata may be backfilled while a newer local reading save is pending.
    // Accept that metadata without rolling back the newer reading position.
    if (!current || (entry.updated_at || 0) >= (current.updated_at || 0)) records.set(entry.hash, { ...current, ...entry });
    else records.set(entry.hash, { ...current, ...entry, reading: current.reading,
      updated_at: current.updated_at, last_read: Math.max(current.last_read || 0, entry.last_read || 0) });
  }
  function progressLabel(item) {
    return item.available === false ? "文件缺失 · 重新导入" : item.reading ? "第 " + item.reading.page + (item.page_count ? " / " + item.page_count : "") + " 页" : "从第一页开始";
  }
  function openVersion(hash) { homeScroll = el("uploadScreen").scrollTop; openPaper(hash); }
  function renderResume(query) {
    const card = el("resumeCard");
    if (!card) return;
    // Select from usable files rather than work groups: the newest edition may
    // be missing while an older edition still has a valid reading position.
    const item = query.trim() ? null : sorted([...records.values()])
      .find((record) => record.available !== false && record.last_read > 0);
    resumeHash = item ? item.hash : null;
    card.classList.toggle("hidden", !item);
    if (!item) return;
    el("resumeTitle").textContent = item.title;
    const position = progressLabel(item);
    el("resumePosition").textContent = position;
    el("resumeTime").textContent = timeLabel(item.last_read);
    el("resumeTime").setAttribute("datetime", new Date(item.last_read).toISOString());
    const mode = { continuous: "连续阅读", single: "单页阅读", duo: "对照翻译" }[item.reading?.mode];
    el("resumeMode").textContent = mode || "";
    el("resumeMode").classList.toggle("hidden", !mode);
    const percent = item.reading && item.page_count > 0
      ? Math.min(100, Math.max(0, item.reading.page / item.page_count * 100)) : 0;
    const progress = el("resumeProgress");
    progress.style.setProperty("--read-percent", percent + "%");
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", "阅读进度");
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    progress.setAttribute("aria-valuenow", String(Math.round(percent)));
    progress.setAttribute("aria-valuetext", position);
    el("btnResumePaper").dataset.hash = item.hash;
    el("btnResumePaper").setAttribute("aria-label", "继续阅读 " + item.title);
  }
  function render() {
    if (!el("uploadScreen") || el("uploadScreen").classList.contains("hidden")) return;
    const query = el("librarySearch").value;
    const papers = grouped([...records.values()]);
    const list = papers.filter((group) => group.versions.some((item) => matches(item.title, query)));
    el("libraryCount").textContent = papers.length + " 篇论文";
    el("libraryResults").textContent = query.trim() ? "找到 " + list.length + " 篇" : "按最近阅读排序";
    el("librarySearchClear").classList.toggle("hidden", !query);
    renderResume(query);
    const fragment = document.createDocumentFragment();
    list.slice(0, limit).forEach((group, index) => {
      const item = group.item;
      const container = document.createElement("div"); container.className = "paper-entry";
      const recent = group.id === papers[0].id && item.last_read > 0;
      container.classList.toggle("recent", recent);
      const row = document.createElement("button");
      row.className = "paper-row"; row.dataset.hash = item.hash; row.type = "button";
      row.setAttribute("aria-label", "打开 " + item.title);
      const number = document.createElement("span"); number.className = "paper-number"; number.textContent = String(index + 1).padStart(2, "0");
      const title = document.createElement("span"); title.className = "paper-title"; title.textContent = item.title; title.title = item.title;
      const progress = document.createElement("span"); progress.className = "paper-progress";
      progress.textContent = progressLabel(item);
      if (recent && item.available !== false && item.reading && item.page_count > 0) {
        const meter = document.createElement("span"); meter.className = "paper-progress-meter";
        meter.setAttribute("aria-hidden", "true");
        meter.style.setProperty("--read-percent", Math.min(100, Math.max(0, item.reading.page / item.page_count * 100)) + "%");
        progress.appendChild(meter);
      }
      const time = document.createElement("time"); time.className = "paper-time"; time.textContent = timeLabel(item.last_read);
      if (item.last_read) { time.dateTime = new Date(item.last_read).toISOString(); time.title = new Date(item.last_read).toLocaleString("zh-CN", { hour12: false }); }
      const arrow = document.createElement("span"); arrow.className = "paper-arrow"; arrow.textContent = "›"; arrow.setAttribute("aria-hidden", "true");
      row.append(number, title, progress, time, arrow);
      row.addEventListener("click", () => openVersion(item.hash));
      container.appendChild(row);
      if (group.versions.length > 1) {
        row.title = "继续最近阅读的可用版本：" + item.file_name;
        const details = document.createElement("details"); details.className = "paper-versions";
        details.open = expandedGroups.has(group.id);
        const summary = document.createElement("summary"); summary.textContent = group.versions.length + " 个版本";
        const hint = document.createElement("p"); hint.className = "paper-versions-hint";
        hint.textContent = "各版本分别保留阅读位置与笔记，点击标题继续最近阅读的可用版本。";
        details.append(summary, hint);
        group.versions.forEach((version) => {
          const button = document.createElement("button"); button.type = "button";
          button.className = "paper-version-row"; button.dataset.hash = version.hash;
          button.setAttribute("aria-label", "打开版本 " + version.file_name);
          const name = document.createElement("span"); name.className = "paper-version-name";
          name.textContent = version.file_name; name.title = version.file_name;
          // Identical filenames are still distinguishable; nothing is renamed on disk.
          if (group.versions.some((other) => other !== version && other.file_name === version.file_name)) name.textContent += " · " + version.hash.slice(0, 8);
          const position = document.createElement("span"); position.textContent = progressLabel(version);
          const lastRead = document.createElement("time"); lastRead.textContent = timeLabel(version.last_read);
          if (version.last_read) lastRead.dateTime = new Date(version.last_read).toISOString();
          button.append(name, position, lastRead);
          button.addEventListener("click", () => openVersion(version.hash));
          details.appendChild(button);
        });
        details.addEventListener("toggle", () => { if (details.isConnected) {
          if (details.open) expandedGroups.add(group.id); else expandedGroups.delete(group.id);
        } });
        container.appendChild(details);
      }
      fragment.appendChild(container);
    });
    el("libraryList").replaceChildren(fragment);
    el("libraryEmpty").classList.toggle("hidden", list.length > 0 || loading);
    el("libraryEmptyTitle").textContent = query.trim() ? "未找到相关论文" : "从第一篇论文开始";
    el("libraryEmptyHint").textContent = query.trim() ? "试试更短的标题关键词，或清空搜索。" : "添加 PDF，阅读位置会自动记住。下次从这里继续。";
    el("libraryMore").classList.toggle("hidden", list.length <= limit);
    status();
  }
  async function flush(keepalive = false) {
    clearTimeout(timer);
    await Promise.all([...pending.entries()].map(async ([hash, body]) => {
      if (sending.has(hash) && !keepalive) return;
      const flight = {};
      sending.set(hash, flight);
      try {
        const result = await request("/api/library/" + hash + "/reading", body, keepalive);
        if (pending.get(hash) === body) { pending.delete(hash); accept(result); }
        if (!pending.size) status("");
      } catch (_) {
        status("阅读状态未保存，请检查服务或数据目录后重试");
      } finally {
        if (sending.get(hash) === flight) sending.delete(hash);
        storeOutbox(); status();
        if (pending.has(hash) && pending.get(hash) !== body) timer = setTimeout(flush, 100);
      }
    }));
  }
  function save(doc, reading, activity) {
    const record = records.get(doc.id);
    if (!record) return;
    if (JSON.stringify(record.reading) === JSON.stringify(reading) && (record.last_read || 0) >= (Number(activity) || 0)) return;
    const updated_at = Math.max(Date.now(), (record.updated_at || 0) + 1);
    const last_read = Math.max(record.last_read || 0, Number(activity) || 0);
    const body = { hash: doc.id, reading, updated_at, last_read };
    records.set(doc.id, { ...record, reading, updated_at, last_read });
    pending.set(doc.id, body); storeOutbox(); status();
    clearTimeout(timer); timer = setTimeout(flush, 400);
  }
  async function load() {
    loading = true; status("");
    try {
      const progress = readLocal("paper-reader-progress", {});
      const recent = readLocal("paper-reader-recent", []);
      const legacy = new Map((Array.isArray(recent) ? recent : []).filter((r) => r && r.hash).map((r) => [r.hash, { ...r, progress: progress && progress[r.hash] }]));
      for (const [hash, value] of Object.entries(progress || {})) if (!legacy.has(hash)) legacy.set(hash, { hash, progress: value });
      const result = legacy.size ? await request("/api/library/migrate", { entries: [...legacy.values()] }) : await request("/api/library");
      result.items.forEach(accept);
      const saved = readLocal(outboxKey, []);
      for (const body of Array.isArray(saved) ? saved : []) {
        if (!body || typeof body.hash !== "string" || !body.reading || !Number.isFinite(body.updated_at)) continue;
        const record = records.get(body.hash);
        if (record && body.reading && body.updated_at > record.updated_at) {
          pending.set(body.hash, body); records.set(body.hash, { ...record, ...body });
        }
      }
      status(result.damaged ? result.damaged + " 条论文记录损坏，原文件已保留，请检查数据目录" : "");
      if (pending.size) await flush();
    } catch (_) { status("无法加载论文库，请重新启动更新后的服务，再点击重试"); }
    loading = false; render();
  }
  function register(data, hash, name, pageCount) {
    if (data.library_entry) accept(data.library_entry);
    else if (!records.has(hash)) accept({ hash, title: String(name).replace(/\.pdf$/i, ""), file_name: name, page_count: pageCount,
      imported_at: Date.now(), last_read: 0, updated_at: 0, reading: null });
    const record = records.get(hash);
    if (record) { record.available = true; record.page_count = pageCount; }
    if (data.library_error) { status(data.library_error); notify(data.library_error); }
  }
  function show() { render(); el("uploadScreen").scrollTop = homeScroll; }
  function init(options) {
    openPaper = options.open; notify = options.toast;
    el("btnResumePaper")?.addEventListener("click", () => { if (resumeHash) openVersion(resumeHash); });
    el("librarySearch").addEventListener("input", () => { limit = 50; render(); });
    el("librarySearchClear").addEventListener("click", () => { el("librarySearch").value = ""; limit = 50; render(); el("librarySearch").focus(); });
    el("librarySearch").addEventListener("keydown", (e) => { if (e.key === "Escape") el("librarySearchClear").click(); });
    el("libraryMore").addEventListener("click", () => { limit += 50; render(); });
    const retry = async () => { await load(); await flush(); };
    el("libraryRetry").addEventListener("click", retry);
    el("readerSaveStatus").addEventListener("click", retry);
    return load();
  }
  return { init, register, get: (hash) => records.get(hash), save, flush, show, render, matches, sorted, grouped, timeLabel };
})();
