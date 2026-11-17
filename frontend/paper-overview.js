"use strict";

const PaperOverview = (() => {
  const labels = {
    motivation: ["研究动机", "未找到可核对的研究动机。"],
    method: ["核心方法", "未找到可核对的方法说明。"],
    results: ["实验发现", "未找到可核对的实验结果。"],
  };
  const jobs = new Map();
  const el = (id) => document.getElementById(id);
  let view;

  function renderState(text, { hint = "", action = "", settings = false, working = false } = {}) {
    el("overviewState").classList.remove("hidden");
    el("overviewNavigation").classList.add("hidden");
    el("overviewSections").classList.add("hidden");
    el("overviewScope").classList.add("hidden");
    el("overviewStatus").textContent = text;
    el("overviewHint").textContent = hint;
    el("overviewHint").classList.toggle("hidden", !hint);
    el("overviewSpinner").classList.toggle("hidden", !working);
    el("btnGenerateOverview").classList.toggle("hidden", !action);
    if (action) el("btnGenerateOverview").textContent = action;
    el("btnOverviewSettings").classList.toggle("hidden", !settings);
  }

  function renderSources(sources, key, label, opened) {
    const citations = document.createElement("div");
    citations.className = "overview-citations";
    const links = document.createElement("div");
    links.className = "overview-sources";
    const caption = document.createElement("span");
    caption.className = "overview-source-label";
    caption.textContent = "原文";
    links.append(caption);
    const quotes = document.createElement("div");
    quotes.className = "overview-quotes hidden";
    quotes.id = "overview-quotes-" + key;
    for (const [index, source] of sources.entries()) {
      const base = `第 ${source.page} 页`;
      const ordinal = sources.slice(0, index).filter((other) => other.page === source.page).length + 1;
      const samePage = sources.some((other) => other !== source && other.page === source.page);
      const reference = samePage ? `${base} · ${ordinal}` : base;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "overview-source-link";
      button.textContent = reference;
      button.setAttribute("aria-label", `跳到${label}的原文出处 ${index + 1}，${base}`);
      button.addEventListener("click", () => {
        el("paperOverview").close();
        opened.readSource(opened.doc, source);
      });
      links.append(button);

      const quote = document.createElement("blockquote");
      quote.className = "overview-quote";
      const passage = document.createElement("p");
      passage.textContent = source.quote;
      const page = document.createElement("cite");
      page.textContent = reference;
      quote.append(passage, page);
      quotes.append(quote);
    }
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "overview-quote-toggle";
    toggle.textContent = "查看摘录";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", quotes.id);
    toggle.addEventListener("click", () => {
      const expanded = !quotes.classList.toggle("hidden");
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.textContent = expanded ? "收起摘录" : "查看摘录";
    });
    citations.append(links, toggle, quotes);
    return citations;
  }

  function renderResult(overview, opened) {
    const container = el("overviewSections");
    container.replaceChildren();
    for (const [key, [label, empty]] of Object.entries(labels)) {
      const section = document.createElement("section");
      section.id = "overview-section-" + key;
      const heading = document.createElement("h3");
      heading.textContent = label;
      heading.tabIndex = -1;
      const body = document.createElement("div");
      body.className = "overview-section-content";
      const text = document.createElement("p");
      text.className = "overview-summary";
      const result = overview.sections[key];
      text.classList.toggle("overview-missing", !result);
      text.textContent = result?.text || empty;
      body.append(text);
      if (result?.points?.length) {
        const points = document.createElement("div");
        points.className = "overview-points";
        for (const [index, point] of result.points.entries()) {
          const item = document.createElement("div");
          item.className = "overview-point";
          const title = document.createElement("h4");
          title.textContent = point.title;
          const detail = document.createElement("p");
          detail.textContent = point.text;
          item.append(title, detail, renderSources(point.sources, `${key}-${index}`, point.title, opened));
          points.append(item);
        }
        body.append(points);
      }
      section.append(heading, body);
      container.append(section);
    }
    el("overviewScope").classList.toggle("hidden", !overview.sampled);
    el("overviewStatus").textContent = "论文速览已生成。";
    el("overviewState").classList.add("hidden");
    el("overviewNavigation").classList.remove("hidden");
    container.classList.remove("hidden");
    el("paperOverviewHeading").focus({ preventScroll: true });
  }

  async function request(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || data.detail || "暂时无法获取论文速览。");
      error.code = data.code;
      throw error;
    }
    return data.overview;
  }

  async function show(opened, job, loading) {
    renderState(loading, { working: true });
    try {
      const result = await job;
      if (view !== opened || !el("paperOverview").open) return;
      if (result) renderResult(result, opened);
      else if (String(opened.settings().api_key || "").trim()) {
        renderState("先了解研究动机、核心方法和实验发现",
          { action: "生成速览", hint: "生成时会将论文正文发送给翻译设置中的模型。" });
      } else {
        renderState("填写翻译 API Key 后即可生成论文速览。", { settings: true });
      }
    } catch (error) {
      if (view !== opened || !el("paperOverview").open) return;
      const needsSettings = ["missing_key", "address", "upstream_401", "upstream_403", "upstream_404"].includes(error.code);
      const retry = error.code !== "missing_text" && !needsSettings;
      renderState(error.message, { action: retry ? "重试" : "", settings: needsSettings });
    }
  }

  function generate() {
    const opened = view;
    if (!opened || !el("paperOverview").open) return;
    const id = opened.doc.id;
    if (!jobs.has(id)) {
      const { api_key, base_url, model } = opened.settings();
      const job = request("/api/paper_overview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdf_hash: id, settings: { api_key, base_url, model } }),
      }).finally(() => jobs.delete(id));
      jobs.set(id, job);
    }
    show(opened, jobs.get(id), "正在阅读论文并整理速览…");
  }

  function open(doc, settings, readSource, openSettings) {
    const dialog = el("paperOverview");
    if (!doc || dialog.open) return;
    const opened = { doc, settings, readSource, openSettings };
    view = opened;
    const record = PaperLibrary.get(doc.id);
    const title = record?.display_title || record?.title || doc.name.replace(/\.pdf$/i, "");
    el("paperOverviewTitle").textContent = title;
    el("paperOverviewTitle").title = title;
    el("overviewBody").scrollTop = 0;
    dialog.showModal();
    const job = jobs.get(doc.id);
    show(opened, job || request("/api/paper_overview/" + encodeURIComponent(doc.id)),
      job ? "正在阅读论文并整理速览…" : "正在读取速览…");
  }

  function init() {
    const dialog = el("paperOverview");
    el("btnCloseOverview").addEventListener("click", () => dialog.close());
    el("btnGenerateOverview").addEventListener("click", generate);
    for (const button of el("overviewNavigation").querySelectorAll("button")) {
      button.addEventListener("click", () => {
        const section = el("overview-section-" + button.dataset.overviewSection);
        const body = el("overviewBody");
        body.scrollTop += section.getBoundingClientRect().top - body.getBoundingClientRect().top;
        section.querySelector("h3").focus({ preventScroll: true });
      });
    }
    el("btnOverviewSettings").addEventListener("click", () => {
      const opened = view;
      dialog.close();
      opened?.openSettings();
    });
  }

  return { init, open };
})();
