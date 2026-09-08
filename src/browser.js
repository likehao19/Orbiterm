import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./browser.css";

export function browserBounds(rect, scale = 1) {
  return { x: rect.x, y: rect.y, width: Math.max(0, rect.width), height: Math.max(0, rect.height), scale };
}

export function clampBrowserWidth(width, available) {
  const maximum = Math.max(0, available);
  return Math.round(Math.max(Math.min(360, maximum), Math.min(width, maximum)));
}

export function createBrowserController({ panel, button, isTauri, tr, onLayout, onOpen, getDefaultWidth = () => 540 }) {
  panel.innerHTML = `
    <div id="browserResize" class="browser-resize" role="separator" aria-orientation="vertical" tabindex="0"></div>
    <header class="browser-head"><strong id="browserTitle"></strong><select id="browserZoom"><option value="0.5">50%</option><option value="0.75">75%</option><option value="0.9">90%</option><option value="1" selected>100%</option><option value="1.1">110%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select><button id="browserClose" type="button">×</button></header>
    <form class="browser-navigation" id="browserForm"><button id="browserBack" type="button" disabled>←</button><button id="browserForward" type="button" disabled>→</button><button id="browserReload" type="button" disabled>↻</button><input id="browserAddress" type="text" spellcheck="false" autocomplete="off" /><button id="browserGo" type="submit">↵</button></form>
    <div id="browserViewport" class="browser-viewport"><div class="browser-placeholder" id="browserPlaceholder"></div></div>
    <footer id="browserStatus" class="browser-status" role="status"></footer>`;
  const el = (id) => panel.querySelector(`#${id}`);
  const model = { available: false, open: false, created: false, url: "", title: "", loading: false };
  let queue = Promise.resolve();
  let frame = null;
  let lastLayout = "";
  let lifetime = 0;
  let preferredWidth = null;
  let appliedWidth = null;
  let drag = null;
  const overlays = [...document.querySelectorAll(".modal, #appPrompt, #paletteOverlay, .terminal-context-menu, #newRemoteMenu, #notifyPop, #sftpPanel, #tailPanel, #manualPanel")];
  const obstructed = () => overlays.some((node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden"
    && (node.id !== "paletteOverlay" || node.classList.contains("open")));
  function call(action, args = {}) {
    const request = queue.then(() => invoke("browser_command", { action, ...args }));
    queue = request.catch(() => {});
    return request;
  }
  function showError(error) {
    model.loading = false;
    el("browserStatus").textContent = String(error);
    el("browserStatus").title = String(error);
    el("browserStatus").classList.add("error");
    el("browserReload").classList.remove("loading");
  }
  function syncLayout() {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (model.open) applyWidth();
      if (!isTauri || !model.created) return;
      const visible = model.open && model.available && !drag && !document.hidden && !obstructed();
      const bounds = browserBounds(el("browserViewport").getBoundingClientRect(), window.devicePixelRatio || 1);
      const signature = visible ? JSON.stringify(bounds) : "hidden";
      if (lastLayout === signature) return;
      lastLayout = signature;
      void call(visible ? "layout" : "hide", visible ? { bounds } : {}).catch((error) => { lastLayout = ""; showError(error); });
    });
  }
  function applyWidth() {
    const available = panel.parentElement.clientWidth;
    const width = clampBrowserWidth(preferredWidth ?? getDefaultWidth(), available);
    if (width !== appliedWidth) {
      appliedWidth = width;
      panel.style.setProperty("--browser-width", `${width}px`);
      onLayout();
    }
    el("browserResize").setAttribute("aria-valuenow", String(width));
    el("browserResize").setAttribute("aria-valuemin", String(clampBrowserWidth(0, available)));
    el("browserResize").setAttribute("aria-valuemax", String(clampBrowserWidth(available, available)));
  }
  function stopResize() {
    drag = null;
    panel.classList.remove("resizing");
    syncLayout();
  }
  function setOpen(open) {
    if (open && !model.open) preferredWidth = null;
    model.open = Boolean(open && model.available);
    if (model.open) onOpen?.();
    else stopResize();
    panel.classList.toggle("hidden", !model.open);
    button.classList.toggle("on", model.open);
    button.setAttribute("aria-expanded", String(model.open));
    if (model.open) applyWidth();
    onLayout();
    syncLayout();
    if (model.open && !model.created) el("browserAddress").focus();
  }
  async function navigate(address) {
    if (!model.available || !model.open || !address.trim()) return;
    if (!isTauri) return showError(tr("内置浏览器需通过 Tauri 启动", "Start the Tauri app to use the built-in browser"));
    const generation = lifetime;
    try {
      el("browserStatus").classList.remove("error");
      el("browserStatus").textContent = tr("正在打开…", "Opening…");
      // Do not expose the native view until layout confirms that no dialog covers it.
      await call("navigate", { address });
      if (generation !== lifetime || !model.available) return;
      model.created = true;
      el("browserPlaceholder").classList.add("hidden");
      el("browserReload").disabled = false;
      await call("zoom", { zoom: Number(el("browserZoom").value) });
      lastLayout = "";
      syncLayout();
    } catch (error) { showError(error); }
  }
  function localize() {
    button.title = tr("内置浏览器", "Built-in browser");
    button.setAttribute("aria-label", button.title);
    el("browserTitle").textContent = model.title || tr("浏览器", "Browser");
    el("browserAddress").placeholder = tr("输入网址，例如 localhost:8080", "Enter a URL, e.g. localhost:8080");
    el("browserAddress").setAttribute("aria-label", tr("网页地址", "Web address"));
    el("browserPlaceholder").textContent = tr("输入网址，在终端旁打开网页", "Enter a URL to browse beside your terminal");
    for (const [id, zh, en] of [["browserResize", "拖动调整浏览器宽度", "Drag to resize browser"], ["browserBack", "后退", "Back"], ["browserForward", "前进", "Forward"], ["browserReload", "刷新网页", "Reload page"], ["browserClose", "关闭浏览器", "Close browser"], ["browserGo", "打开网页", "Go"], ["browserZoom", "网页缩放", "Page zoom"]]) {
      el(id).title = tr(zh, en);
      el(id).setAttribute("aria-label", tr(zh, en));
    }
  }
  button.addEventListener("click", () => setOpen(!model.open));
  el("browserClose").addEventListener("click", () => setOpen(false));
  const handle = el("browserResize");
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, width: panel.getBoundingClientRect().width, pointerId: event.pointerId };
    panel.classList.add("resizing");
    // Native webviews do not participate in DOM pointer capture; hide while dragging across them.
    syncLayout();
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    preferredWidth = clampBrowserWidth(drag.width + drag.x - event.clientX, panel.parentElement.clientWidth);
    applyWidth();
    syncLayout();
  });
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) handle.addEventListener(event, stopResize);
  handle.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    preferredWidth = clampBrowserWidth(appliedWidth + (event.key === "ArrowLeft" ? 20 : -20), panel.parentElement.clientWidth);
    applyWidth();
    syncLayout();
  });
  el("browserForm").addEventListener("submit", (event) => { event.preventDefault(); void navigate(el("browserAddress").value); });
  for (const [id, action] of [["browserBack", "back"], ["browserForward", "forward"], ["browserReload", "reload"]]) {
    el(id).addEventListener("click", () => { void call(action).catch(showError); });
  }
  el("browserZoom").addEventListener("change", () => {
    if (model.created) void call("zoom", { zoom: Number(el("browserZoom").value) }).catch(showError);
  });
  const resize = new ResizeObserver(syncLayout);
  resize.observe(el("browserViewport"));
  resize.observe(panel.parentElement);
  const mutations = new MutationObserver(syncLayout);
  overlays.forEach((node) => mutations.observe(node, { attributes: true, attributeFilter: ["class", "style"] }));
  window.addEventListener("resize", syncLayout);
  document.addEventListener("visibilitychange", syncLayout);
  if (isTauri) {
    void listen("orbiterm-browser-state", ({ payload }) => {
      if (!model.available) return;
      if (payload.url != null) {
        model.url = payload.url;
        if (document.activeElement !== el("browserAddress")) el("browserAddress").value = payload.url;
      }
      if (payload.title != null) { model.title = payload.title; el("browserTitle").textContent = payload.title || tr("浏览器", "Browser"); }
      if (payload.loading != null) {
        model.loading = payload.loading;
        el("browserReload").classList.toggle("loading", payload.loading);
        el("browserStatus").classList.remove("error");
        el("browserStatus").textContent = payload.loading ? tr("正在加载…", "Loading…") : tr("就绪", "Ready");
      }
      if (payload.canGoBack != null) el("browserBack").disabled = !payload.canGoBack;
      if (payload.canGoForward != null) el("browserForward").disabled = !payload.canGoForward;
      if (payload.error) showError(payload.error);
    }).catch(showError);
    void listen("orbiterm-browser-open-url", ({ payload }) => {
      if (model.open && !obstructed()) void navigate(payload);
    }).catch(showError);
  }
  localize();
  return {
    close() { if (model.open) setOpen(false); },
    localize,
    syncLayout,
    setAvailable(available) {
      const changed = model.available !== available;
      model.available = available;
      button.disabled = !available;
      if (!available && changed) {
        lifetime += 1;
        setOpen(false);
        model.created = false;
        model.url = "";
        model.title = "";
        model.loading = false;
        lastLayout = "";
        el("browserStatus").textContent = "";
        el("browserStatus").title = "";
        el("browserStatus").classList.remove("error");
        el("browserReload").classList.remove("loading");
        el("browserAddress").value = "";
        el("browserBack").disabled = true;
        el("browserForward").disabled = true;
        el("browserReload").disabled = true;
        el("browserPlaceholder").classList.remove("hidden");
        localize();
        if (isTauri) void call("close").catch(showError);
      }
    },
  };
}
