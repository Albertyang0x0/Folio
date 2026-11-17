/* Lightweight local-storage overview. Destructive scope is intentionally limited to translation cache. */
"use strict";

const StorageManager = (() => {
  const isMac = document.documentElement.dataset.platform === "macos";
  let notify = () => {}, current = null, returnFocus = null;
  const el = (id) => document.getElementById(id);
  const labels = { papers: "原始论文", extracted: "版面数据", translations: "翻译与速览缓存", records: "阅读记录", other: "其他应用文件" };

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
    } catch (_) { return null; }
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
    el("storagePath").removeAttribute("title");
    updateLocationActions();
    el("storageMeter").replaceChildren();
    document.querySelectorAll(".storage-row").forEach((row) => {
      row.querySelector(".storage-size").textContent = "—";
      row.querySelector(".storage-count").textContent = "";
    });
    el("btnClearStorageCache").disabled = true;
    setError("");
  }

  function updateLocationActions() {
    const reveal = el("btnRevealStoragePath");
    const canReveal = isMac && typeof window.pywebview?.api?.reveal_data_dir === "function";
    reveal.classList.toggle("hidden", !canReveal);
    reveal.disabled = !current?.data_dir;
    el("btnCopyStoragePath").disabled = !current?.data_dir;
  }

  function render(data) {
    const categories = data.categories;
    const total = Math.max(0, Number(data.total_bytes) || 0);
    const desktopProfile = data.desktop_mode && typeof window.pywebview?.api === "object";
    const profileInDirectory = desktopProfile && !isMac;
    const profileBytes = profileInDirectory ? null : browserBytes();
    current = { ...data, categories };
    el("storageModal").removeAttribute("aria-busy");
    el("storageTotal").textContent = formatBytes(total);
    el("storageFree").textContent = data.free_bytes == null ? "磁盘余量不可用" : "磁盘可用 " + formatBytes(data.free_bytes);
    el("storagePath").textContent = data.data_dir || "—";
    el("storagePath").title = data.data_dir || "";
    updateLocationActions();
    const meter = el("storageMeter");
    meter.replaceChildren();
    const visible = ["papers", "extracted", "translations", "records", "other"];
    for (const name of visible) {
      const category = categories[name] || { bytes: 0, files: 0 };
      const row = document.querySelector('[data-storage-category="' + name + '"]');
      row.querySelector(".storage-size").textContent = formatBytes(category.bytes);
      row.querySelector(".storage-count").textContent = category.files + " 个文件";
      if (category.bytes > 0) {
        const segment = document.createElement("span");
        segment.className = name === "other" ? "browser" : name;
        segment.style.flexGrow = String(category.bytes);
        segment.title = labels[name] + " · " + formatBytes(category.bytes);
        meter.appendChild(segment);
      }
    }
    meter.setAttribute("aria-label", "数据目录共使用 " + formatBytes(total) + "，" + visible.map((name) =>
      labels[name] + " " + formatBytes((categories[name] || {}).bytes)).join("，"));

    const profile = document.querySelector('[data-storage-category="browser"]');
    profile.querySelector(".storage-size").textContent = profileBytes == null ? "—" : "约 " + formatBytes(profileBytes);
    profile.querySelector(".storage-count").textContent = profileInDirectory ? "已计入其他应用文件" : "单独存储";
    const profileLocation = profileInDirectory ? "由便携版的 WebView2 保存" :
      desktopProfile && isMac ? "由 macOS 的 WebKit 保存" : "保存在当前浏览器中";
    el("storageProfileLocation").textContent = profileLocation;
    el("storageBackupHint").textContent = profileInDirectory
      ? "备份整个论文数据目录可以保留 PDF、阅读位置、笔记、书签与设置。"
      : "备份数据目录会保留 PDF、版面、译文缓存和阅读位置。笔记、书签与设置" + profileLocation + "，需另外备份站点数据。";
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
    el("storageModal").inert = false;
    el("btnCloseStorage").focus({ preventScroll: true });
    load();
  }

  function close() {
    if (el("storageModal").classList.contains("hidden")) return;
    el("storageModal").inert = true;
    el("storageModal").classList.add("hidden");
    if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }

  async function clearTranslations() {
    const size = current?.categories?.translations?.bytes || 0;
    if (!size || !confirm("清理 " + formatBytes(size) + " 的翻译和速览缓存？\n\n再次查看译文或速览时需要重新生成。")) return;
    const button = el("btnClearStorageCache");
    button.disabled = true; button.textContent = "正在清理…"; setError("");
    try {
      const response = await fetch("/api/clear_cache", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.detail || "清理未完成");
      if (data.storage) render(data.storage); else await load();
      notify(data.freed_bytes ? "已释放 " + formatBytes(data.freed_bytes) : "缓存已清空");
    } catch (error) {
      setError(error.message || "清理缓存失败，请重试");
      button.disabled = false;
    } finally { button.textContent = "清理翻译与速览"; }
  }

  function init(options = {}) {
    notify = options.toast || notify;
    el("btnStorage").addEventListener("click", () => open(el("btnStorage")));
    el("btnCloseStorage").addEventListener("click", close);
    el("btnDoneStorage").addEventListener("click", close);
    el("btnReloadStorage").addEventListener("click", load);
    el("btnClearStorageCache").addEventListener("click", clearTranslations);
    window.addEventListener("pywebviewready", updateLocationActions);
    el("btnRevealStoragePath").addEventListener("click", async () => {
      try {
        if (!await window.pywebview?.api?.reveal_data_dir()) notify("无法打开论文数据目录");
      } catch (_) { notify("无法打开论文数据目录，请复制路径后在 Finder 中打开"); }
    });
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
