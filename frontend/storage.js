/* Lightweight local-storage overview. Destructive scope is intentionally limited to translation cache. */
"use strict";

const StorageManager = (() => {
  let notify = () => {}, current = null, returnFocus = null;
  const el = (id) => document.getElementById(id);
  const labels = { papers: "原始论文", extracted: "版面数据", translations: "翻译缓存", records: "阅读记录", browser: "笔记与应用数据" };

  function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return bytes + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let size = bytes / 1024, unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
    return size.toLocaleString("zh-CN", { maximumFractionDigits: size < 10 ? 2 : size < 100 ? 1 : 0 }) + " " + units[unit];
  }

  function browserBytes() {
    let bytes = 0;
    try {
      const encoder = new TextEncoder();
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith("paper-reader-")) bytes += encoder.encode(key + (localStorage.getItem(key) || "")).byteLength;
      }
    } catch (_) { return 0; }
    return bytes;
  }

  function setError(message) {
    const error = el("storageError");
    error.textContent = message || "";
    error.classList.toggle("hidden", !message);
    el("btnReloadStorage").classList.toggle("hidden", !message);
  }

  function setLoading() {
    current = null;
    el("storageModal").setAttribute("aria-busy", "true");
    el("storageTotal").textContent = "正在计算…";
    el("storageFree").textContent = "磁盘空间读取中";
    el("storagePath").textContent = "—";
    el("storageMeter").replaceChildren();
    document.querySelectorAll(".storage-row").forEach((row) => {
      row.querySelector(".storage-size").textContent = "—";
      if (row.dataset.storageCategory !== "browser") row.querySelector(".storage-count").textContent = "";
    });
    el("btnClearStorageCache").disabled = true;
    setError("");
  }

  function render(data) {
    const clientBytes = data.desktop_mode ? 0 : browserBytes();
    const application = data.categories?.other || { bytes: 0, files: 0 };
    const categories = { ...data.categories, browser: {
      bytes: Math.max(0, Number(application.bytes) || 0) + clientBytes,
      files: Math.max(0, Number(application.files) || 0),
    } };
    const total = Math.max(0, Number(data.total_bytes) || 0) + clientBytes;
    current = { ...data, categories, total };
    el("storageModal").removeAttribute("aria-busy");
    el("storageTotal").textContent = formatBytes(total);
    el("storageFree").textContent = data.free_bytes == null ? "磁盘余量不可用" : "磁盘可用 " + formatBytes(data.free_bytes);
    el("storagePath").textContent = data.data_dir || "—";
    el("storagePath").title = data.data_dir || "";
    const meter = el("storageMeter");
    meter.replaceChildren();
    const visible = ["papers", "extracted", "translations", "records", "browser"];
    for (const name of visible) {
      const category = categories[name] || { bytes: 0, files: 0 };
      const row = document.querySelector('[data-storage-category="' + name + '"]');
      row.querySelector(".storage-size").textContent = formatBytes(category.bytes);
      row.querySelector(".storage-count").textContent = name === "browser"
        ? (data.desktop_mode ? category.files + " 个本地文件" : "浏览器本地")
        : category.files + " 个文件";
      if (category.bytes > 0) {
        const segment = document.createElement("span");
        segment.className = name;
        segment.style.flexGrow = String(category.bytes);
        segment.title = labels[name] + " · " + formatBytes(category.bytes);
        meter.appendChild(segment);
      }
    }
    meter.setAttribute("aria-label", "共使用 " + formatBytes(total) + "；" + visible.map((name) =>
      labels[name] + " " + formatBytes((categories[name] || {}).bytes)).join("；"));
    el("btnClearStorageCache").disabled = !(categories.translations?.bytes > 0);
    setError("");
  }

  async function load() {
    setLoading();
    try {
      const response = await fetch("/api/storage", { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.categories) throw new Error(data.detail || "存储信息暂时不可用");
      render(data);
    } catch (error) {
      el("storageModal").removeAttribute("aria-busy");
      setError(error.message || "存储信息暂时不可用，请重试");
    }
  }

  function focusable() {
    return [...el("storageModal").querySelectorAll('button:not(:disabled), [tabindex="0"]')]
      .filter((node) => node.getClientRects().length);
  }

  function open(focusTarget) {
    if (!el("storageModal").classList.contains("hidden")) return;
    returnFocus = focusTarget || document.activeElement;
    el("storageModal").classList.remove("hidden");
    el("btnCloseStorage").focus({ preventScroll: true });
    load();
  }

  function close() {
    if (el("storageModal").classList.contains("hidden")) return;
    el("storageModal").classList.add("hidden");
    if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }

  async function clearTranslations() {
    const size = current?.categories?.translations?.bytes || 0;
    if (!size || !confirm("清理 " + formatBytes(size) + " 翻译缓存？\n\nPDF、笔记、书签和阅读进度会保留。再次查看译文时需要重新调用翻译接口。")) return;
    const button = el("btnClearStorageCache");
    button.disabled = true; button.textContent = "正在清理…"; setError("");
    try {
      const response = await fetch("/api/clear_cache", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.detail || "清理未完成");
      if (data.storage) render(data.storage); else await load();
      notify(data.freed_bytes ? "已释放 " + formatBytes(data.freed_bytes) : "翻译缓存已清空");
    } catch (error) {
      setError(error.message || "清理缓存失败，请重试");
      button.disabled = false;
    } finally { button.textContent = "清理翻译缓存"; }
  }

  function init(options = {}) {
    notify = options.toast || notify;
    el("btnStorage").addEventListener("click", () => open(el("btnStorage")));
    el("btnCloseStorage").addEventListener("click", close);
    el("btnDoneStorage").addEventListener("click", close);
    el("btnReloadStorage").addEventListener("click", load);
    el("btnClearStorageCache").addEventListener("click", clearTranslations);
    el("btnCopyStoragePath").addEventListener("click", async () => {
      const path = current?.data_dir;
      if (!path) return;
      try { await navigator.clipboard.writeText(path); notify("存储路径已复制"); }
      catch (_) { notify("无法复制，请手动选择存储路径"); }
    });
    el("storageModal").addEventListener("click", (event) => { if (event.target === el("storageModal")) close(); });
    el("storageModal").addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); event.stopPropagation(); return; }
      if (event.key !== "Tab") return;
      const controls = focusable(), first = controls[0], last = controls[controls.length - 1];
      if (!first) return;
      if (!controls.includes(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    });
  }

  return { init, open, close, formatBytes };
})();
