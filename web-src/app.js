import {installHostUI} from "./host-ui.js";
import {mergeChanges} from "./timeline.js";
import {nativePreview} from "./native-preview.js";
"use strict";

// 页面只保留一组轮询；各摄像头的失败与重连互不影响。
(() => {
  const ui = {};
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const pageNames = {live: "实时画面", recordings: "录像回放", events: "智能事件", settings: "设备设置"};
  const categoryNames = {person: "人", vehicle: "车", animal: "动物"};
  const eventNames = {dwell: "长时间停留", person: "人", vehicle: "车", animal: "动物"};
  const cropChoices = [["完整画面", [0, 0, 1, 1]], ["左上区域", [0, 0, 0.5, 0.5]], ["右上区域", [0.5, 0, 0.5, 0.5]], ["左下区域", [0, 0.5, 0.5, 0.5]], ["右下区域", [0.5, 0.5, 0.5, 0.5]]];
  const liveStates = new Set(["online", "running", "streaming", "connected", "live", "ok"]);
  const stateNames = {online: "在线", running: "在线", streaming: "在线", connected: "在线", live: "在线", ok: "在线", disabled: "已停用", offline: "无信号", no_signal: "无信号", waiting: "等待信号", connecting: "连接中", reconnecting: "重新连接", error: "连接异常", stopped: "已停止", starting: "启动中"};
  const state = {page: "live", config: null, status: null, dirty: false, saving: false, connected: false, timer: null, pollBusy: false, toastTimer: null, cards: new Map(), requests: {recordings: 0, events: 0}, nextListRefresh: 0, nextDiagnosticsRefresh: 0, storageTargets: null, storageTargetError: "", copySourceId: null};

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  async function api(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, {...options, signal: controller.signal, cache: "no-store", headers: {"Accept": "application/json", ...(options.body ? {"Content-Type": "application/json"} : {}), ...options.headers}});
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || (response.status === 404 ? "接口暂不可用，请检查服务版本。" : `请求失败（${response.status}）`));
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("设备响应超时，请稍后重试。");
      if (error instanceof TypeError) throw new Error("无法连接开发板，请检查网络与服务。");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function toast(message) {
    const target = $("#toast");
    target.textContent = message;
    target.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { target.hidden = true; }, 4500);
  }

  function dateText(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", {hour12: false});
  }

  function bytesText(value) {
    if (value === null || value === undefined || value === "") return "—";
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }

  function durationText(value) {
    const seconds = Math.round(Number(value));
    if (!Number.isFinite(seconds) || seconds < 0) return "—";
    return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
  }

  function metricNumber(value) {
    return value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
  }

  function uptimeText(value) {
    const seconds = metricNumber(value);
    if (seconds === null || seconds < 0) return "运行时间暂不可用";
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor(seconds / 3600) % 24;
    const minutes = Math.floor(seconds / 60) % 60;
    return `服务已运行 ${days ? `${days} 天 ` : ""}${hours ? `${hours} 小时 ` : ""}${minutes} 分钟`;
  }

  function updateSystem(data) {
    const system = data.system || {};
    const storage = data.storage || {};
    const memory = system.memory || {};
    const temperature = metricNumber(system.temperature_c);
    const cpu = metricNumber(system.cpu_percent);
    $("#system-hostname").textContent = system.hostname || "RK3399 PRO";
    $("#system-uptime").textContent = uptimeText(data.uptime_seconds);
    $("#system-temperature").textContent = temperature === null ? "—" : `${temperature.toFixed(1)} °C`;
    $("#system-cpu").textContent = cpu === null ? "—" : `${cpu.toFixed(1)} %`;
    $("#system-cpu-meter").value = Math.max(0, Math.min(100, cpu || 0));
    $("#system-cpu-meter").hidden = cpu === null;
    $("#system-memory").textContent = `${bytesText(memory.used_bytes)} / ${bytesText(memory.total_bytes)}`;
    const memoryPercent = metricNumber(memory.used_percent);
    $("#system-memory-meter").value = Math.max(0, Math.min(100, memoryPercent || 0));
    $("#system-memory-meter").hidden = memoryPercent === null;
    $("#system-storage").textContent = `${bytesText(storage.free_bytes)} / ${bytesText(storage.total_bytes)}`;
    const selectedId = storage.target_id || state.config?.storage?.target_id || "internal";
    const target = state.storageTargets?.find(item => item.id === selectedId);
    $("#system-storage-label").textContent = storage.recording_allowed === false ? "空间或介质不可用 · 录像已暂停" : target?.label || (selectedId === "internal" ? "当前使用内置存储" : "当前使用外部存储");
    $("#system-storage-label").title = storage.error || target?.mountpoint || "";
    $("#system-health").textContent = storage.recording_allowed === false ? "录像暂停" : "设备运行中";
    $("#system-health").className = `badge ${storage.recording_allowed === false ? "error" : "live"}`;
  }

  function channelName(id) {
    return state.config?.channels?.find(channel => String(channel.id) === String(id))?.name || `AHD ${id}`;
  }

  // 后端返回的媒体地址仅允许本机 HTTP 地址，避免配置或列表内容注入链接。
  function mediaUrl(value) {
    if (typeof value !== "string" || !value) return null;
    try {
      const url = new URL(value, location.origin);
      return url.origin === location.origin && ["http:", "https:"].includes(url.protocol) ? url.href : null;
    } catch (_) { return null; }
  }

  function isOnline(channel) {
    return channel.enabled !== false && liveStates.has(channel.state);
  }

  function positionBoxes(card) {
    const {naturalWidth, naturalHeight} = card.img;
    if (!naturalWidth || !naturalHeight || card.img.hidden || !card.online) {
      card.boxes.hidden = true;
      return;
    }
    // object-fit: contain 会产生黑边；检测框要对齐实际图像，而不是整个容器。
    const width = card.screen.clientWidth;
    const height = card.screen.clientHeight;
    const scale = Math.min(width / naturalWidth, height / naturalHeight);
    const imageWidth = naturalWidth * scale;
    const imageHeight = naturalHeight * scale;
    Object.assign(card.boxes.style, {left: `${(width - imageWidth) / 2}px`, top: `${(height - imageHeight) / 2}px`, width: `${imageWidth}px`, height: `${imageHeight}px`});
    card.boxes.hidden = !card.boxes.childElementCount;
  }

  function updateBoxes(card, detections) {
    const fragment = document.createDocumentFragment();
    for (const detection of detections.slice(0, 20)) {
      if (!Array.isArray(detection.bbox) || detection.bbox.length !== 4 || !detection.bbox.every(Number.isFinite)) continue;
      const [x1, y1, x2, y2] = detection.bbox.map(value => Math.min(1, Math.max(0, value)));
      if (x2 <= x1 || y2 <= y1) continue;
      const category = Object.prototype.hasOwnProperty.call(categoryNames, detection.category) ? detection.category : "person";
      const dwellEligible = detection.category === "person" && detection.dwell_eligible !== false;
      const dwellReached = dwellEligible && detection.dwell_reached === true;
      const box = el("div", `detection-box detection-${dwellReached ? "dwell" : category}`);
      Object.assign(box.style, {left: `${x1 * 100}%`, top: `${y1 * 100}%`, width: `${(x2 - x1) * 100}%`, height: `${(y2 - y1) * 100}%`});
      const dwell = metricNumber(detection.dwell_seconds);
      let label = categoryNames[detection.category] || "目标";
      // 车和动物仅显示类别；人达到停留阈值后用红框提示。
      if (dwellEligible) label += ` · ${dwellReached ? "长时间停留 " : ""}${dwell !== null && dwell >= 0 ? `${dwell.toFixed(1)} 秒` : "计时中"}`;
      box.append(el("span", "detection-box-label", label));
      fragment.append(box);
    }
    card.boxes.replaceChildren(fragment);
    positionBoxes(card);
  }

  function stopStream(card, reset = false) {
    clearTimeout(card.retryTimer);
    card.retryTimer = null;
    card.img.removeAttribute("src");
    card.streaming = false;
    card.img.hidden = true;
    card.placeholder.hidden = false;
    card.boxes.hidden = true;
    card.boxes.replaceChildren();
    if (reset) card.retries = 0;
  }

  function startStream(card) {
    if (card.streaming || card.retryTimer || state.page !== "live" || state.detailChannel || document.hidden || !state.connected || !card.online || card.retries > 3) return;
    card.streaming = true;
    if (nativePreview) {
      card.img.dataset.nativeChannel = card.id;
      card.img.hidden = false;
      card.placeholder.hidden = true;
      return;
    }
    card.img.src = `/stream/${encodeURIComponent(card.id)}.mjpg?t=${Date.now()}`;
  }

  function syncStreams(reset = false) {
    for (const card of state.cards.values()) {
      if (reset) stopStream(card, true);
      if (state.page !== "live" || state.detailChannel || document.hidden || !card.online || !state.connected) stopStream(card);
      else startStream(card);
    }
  }

  function buildCameras() {
    const grid = $("#camera-grid");
    for (let id = 1; id <= 5; id += 1) {
      const node = $("#camera-template").content.firstElementChild.cloneNode(true);
      const card = {id, node, img: $(".camera-image", node), screen: $(".camera-screen", node), boxes: $(".camera-boxes", node), placeholder: $(".camera-placeholder", node), detections: [], online: false, streaming: false, retries: 0, retryTimer: null};
      $(".camera-number", node).textContent = String(id).padStart(2, "0");
      $(".camera-name strong", node).textContent = `AHD ${id}`;
      card.img.alt = `AHD ${id} 实时画面`;
      card.img.addEventListener("load", () => {
        if (!card.online || state.page !== "live" || state.detailChannel || document.hidden) return;
        card.img.hidden = false;
        card.placeholder.hidden = true;
        updateBoxes(card, card.detections);
      });
      card.img.addEventListener("error", () => {
        if (!card.streaming) return;
        stopStream(card);
        card.retries += 1;
        $("strong", card.placeholder).textContent = "预览连接中断";
        $("small", card.placeholder).textContent = card.retries <= 3 ? "正在尝试恢复预览" : "请点击“重新连接画面”重试";
        if (card.retries <= 3) card.retryTimer = setTimeout(() => { card.retryTimer = null; startStream(card); }, card.retries * 2500);
      });
      $(".camera-fullscreen", node).addEventListener("click", () => {
        const expanded = node.classList.contains("camera-expanded");
        for (const other of $$(".camera-expanded")) other.classList.remove("camera-expanded");
        node.classList.toggle("camera-expanded", !expanded);
        positionBoxes(card);
      });
      $(".camera-snapshot", node).addEventListener("click", async () => {
        if (!card.online) return toast("当前通道暂无画面。");
        if (location.hostname === "127.0.0.1") {
          const link = el("a"); link.href = `/api/snapshot/${id}.jpg?download=1`;
          link.click(); return;
        }
        try {
          const response = await fetch(`/api/snapshot/${id}.jpg`, {cache: "no-store", signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined});
          if (!response.ok) throw new Error("截图暂不可用，请稍后重试。");
          const url = URL.createObjectURL(await response.blob());
          const link = el("a");
          link.href = url;
          link.download = `AHD${id}_${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
        } catch (error) { toast(error.message || "截图失败，请检查连接。"); }
      });
      state.cards.set(String(id), card);
      grid.append(node);
      if (typeof ResizeObserver !== "undefined") {
        card.resizeObserver = new ResizeObserver(() => positionBoxes(card));
        card.resizeObserver.observe(card.screen);
      }
    }
  }

  function updateStatus(data) {
    const channels = Array.isArray(data.channels) ? data.channels : [];
    const online = channels.filter(isOnline).length;
    $("#online-count").textContent = online;
    $("#recording-count").textContent = channels.filter(channel => channel.recording === true || channel.recording?.active === true).length;
    $("#online-hint").textContent = online === 5 ? "所有通道已连接" : online ? `${5 - online} 路未接入或已停用` : "等待摄像头接入";
    const detector = data.detector || {};
    $("#detector-state").textContent = detector.ready ? "已就绪" : detector.error ? "暂不可用" : "准备中";
    $("#detector-backend").textContent = detector.backend || "AI";
    $("#detector-hint").textContent = detector.error || "人 · 车 · 动物";
    $("#detector-hint").title = detector.error || "";
    const storage = data.storage || {};
    $("#free-space").textContent = metricNumber(storage.free_bytes) === null ? "—" : (Number(storage.free_bytes) / 1024 ** 3).toFixed(1);
    $("#storage-hint").textContent = storage.recording_allowed === false ? "录像已暂停 · 请检查介质与空间" : storage.total_bytes ? `总容量 ${bytesText(storage.total_bytes)}` : "暂无法读取存储空间";
    updateSystem(data);
    for (const card of state.cards.values()) {
      const channel = channels.find(item => String(item.id) === String(card.id)) || {enabled: true, state: "waiting"};
      const wasOnline = card.online;
      card.online = isOnline(channel);
      if (card.online !== wasOnline) stopStream(card, true);
      $(".camera-name strong", card.node).textContent = channel.name || channelName(card.id);
      card.img.alt = `${channel.name || channelName(card.id)} 实时画面`;
      const badge = $(".camera-state", card.node);
      badge.textContent = channel.enabled === false ? "已停用" : stateNames[channel.state] || "等待信号";
      badge.className = `camera-state badge${card.online ? " live" : channel.error ? " error" : ""}`;
      badge.title = channel.error || "";
      $(".recording-badge", card.node).hidden = !(card.online && (channel.recording === true || channel.recording?.active === true));
      const previewFps = metricNumber(channel.preview_fps ?? channel.fps);
      const recordingFps = metricNumber(channel.recording_fps);
      const info = $(".camera-info", card.node);
      const config = state.config?.channels?.find(item => String(item.id) === String(card.id));
      info.textContent = card.online ? `预览 ${previewFps === null ? "—" : previewFps.toFixed(1)} · 录像 ${recordingFps === null ? "—" : recordingFps.toFixed(1)} fps` : channel.enabled === false ? "通道已停用" : "等待视频信号 · 自动重连";
      info.title = card.online ? `实际帧率：预览 ${previewFps === null ? "—" : previewFps.toFixed(1)} fps，录像 ${recordingFps === null ? "—" : recordingFps.toFixed(1)} fps。设置目标：录像 ${config?.fps ?? "—"} fps，预览 ${config?.preview_fps ?? "—"} fps。实际值随设备负载和网络状态变化。` : channel.error || "";
      if (!card.online || card.retries === 0) {
        $("strong", card.placeholder).textContent = channel.enabled === false ? "通道已停用" : card.online ? "正在连接画面" : "暂无信号";
        $("small", card.placeholder).textContent = channel.enabled === false ? "可在设备设置中启用" : channel.error || (card.online ? "请稍候" : "摄像头接入后自动恢复");
      }
      const detections = Array.isArray(channel.detections) ? channel.detections : [];
      card.detections = card.online ? detections.filter(item => item && typeof item === "object") : [];
      updateBoxes(card, card.detections);
      const labels = [...new Set(card.detections.map(item => categoryNames[item.category] || item.label || "目标"))];
      const detectionLabel = $(".camera-detections", card.node);
      detectionLabel.hidden = !card.online || !labels.length;
      detectionLabel.textContent = `侦测到：${labels.join("、")}`;
    }
    syncStreams();
  }

  function connectionChanged(connected, error = "") {
    state.connected = connected;
    $("#connection-dot").className = `connection-dot ${connected ? "online" : "offline"}`;
    $("#connection-label").textContent = connected ? "设备已连接" : "设备连接中断";
    $("#connection-warning").hidden = connected;
    $("#connection-warning").textContent = `${error} 页面会自动重新连接，已保存的设置不受影响。`;
    $(".system-panel").classList.toggle("stale", !connected);
    if (!connected) {
      $("#system-health").textContent = "状态未更新";
      $("#system-health").className = "badge error";
      $("#online-count").textContent = "—";
      $("#recording-count").textContent = "—";
      $("#online-hint").textContent = "连接中断，无法确认当前状态";
      for (const card of state.cards.values()) {
        stopStream(card, true);
        $("strong", card.placeholder).textContent = "设备连接中断";
        $("small", card.placeholder).textContent = "网络恢复后自动重新连接";
        $(".camera-state", card.node).textContent = "状态未知";
        $(".camera-state", card.node).className = "camera-state badge error";
        $(".recording-badge", card.node).hidden = true;
        $(".camera-detections", card.node).hidden = true;
      }
    }
  }

  async function poll() {
    clearTimeout(state.timer);
    if (state.pollBusy || document.hidden) return;
    state.pollBusy = true;
    try {
      const status = await api("/api/status");
      state.status = status;
      connectionChanged(true);
      updateStatus(status);
      if(ui.onStatus) ui.onStatus();
      if (!state.config) await loadConfig();
      if (["recordings", "events"].includes(state.page) && Date.now() >= state.nextListRefresh) {
        state.nextListRefresh = Date.now() + 15000;
        await loadList(state.page, false);
      }
      if (state.page === "settings" && Date.now() >= state.nextDiagnosticsRefresh) loadDiagnostics();
    } catch (error) { connectionChanged(false, error.message); if(ui.onStatus)ui.onStatus(); }
    finally {
      state.pollBusy = false;
      if (!document.hidden) state.timer = setTimeout(poll, 3000);
    }
  }

  function setPage(name, updateHash = true) {
    if (!(name in pageNames)) name = "live";
    state.page = name;
    $$(".page").forEach(page => { page.hidden = page.id !== `page-${name}`; });
    $$(".nav-button").forEach(button => {
      button.classList.toggle("active", button.dataset.page === name);
      if (button.dataset.page === name) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    $("#page-label").textContent = pageNames[name];
    document.title = `${pageNames[name]} · 智能录像机`;
    window.scrollTo(0, 0);
    if (updateHash) history.replaceState(null, "", `#${name}`);
    syncStreams(true);
    if (["recordings", "events"].includes(name)) {
      state.nextListRefresh = Date.now() + 15000;
      loadList(name, true);
    }
    if(ui.onPage) ui.onPage();
    if (name === "settings") {
      if (!state.config) loadConfig();
      if (!state.storageTargets) loadStorageTargets();
      loadDiagnostics();
    }
  }

  function diagnosticFeedback(selector, message, error = false) {
    const node = $(selector);
    node.textContent = message;
    node.hidden = !message;
    node.className = `diagnostic-feedback${error ? " error" : ""}`;
  }

  function renderModelInfo(data) {
    state.model=data;
    $("#model-name").textContent = data.name || "—";
    $("#model-version").textContent = data.version || "—";
    const commit = typeof data.commit === "string" ? data.commit : "";
    $("#model-commit").textContent = commit ? commit.slice(0, 8) : "—";
    $("#model-commit").title = commit;
    $("#model-backend").textContent = data.backend_label || data.backend || "—";
    $("#model-runtime").textContent = [data.tracker, data.opencv_version ? `OpenCV ${data.opencv_version}` : "", data.sdk_version || ""].filter(Boolean).join(" · ") || "运行库版本：—";
    const files = Array.isArray(data.files) ? data.files : [];
    const verified = files.length > 0 && files.every(file => file.verified === true);
    const failed = files.some(file => file.verified === false);
    $("#model-weights").textContent = verified ? "校验通过" : failed ? "校验未通过" : "未校验";
    $("#model-weights").className = `badge${verified ? " live" : failed ? " error" : ""}`;
    $("#model-weights").title = files.map(file => `${file.name || "模型文件"} · ${bytesText(file.size_bytes)} · SHA-256 ${file.sha256 || "—"}`).join("\n");
    for (const key of ["vpu", "npu"]) {
      const accelerator = data[key] || {};
      const enabled = accelerator.used === true ? "已启用" : accelerator.used === false ? "未启用" : "—";
      const value = $(`#model-${key}`);
      value.replaceChildren();
      if (accelerator.used === true && accelerator.backend) value.append(el("span", "", `${accelerator.backend} · `));
      value.append(el("span", "acceleration-state", enabled));
      const channels = Array.isArray(accelerator.channels) && accelerator.channels.length ? `通道 ${accelerator.channels.join("、")}。` : "";
      $(`#model-${key}-note`).textContent = `${channels}${accelerator.note || ""}` || "—";
    }
    const mapping = $("#model-category-mapping");
    mapping.replaceChildren();
    for (const [key, label] of Object.entries(categoryNames)) {
      const labels = data.category_mapping?.[key];
      if (!Array.isArray(labels) || !labels.length) continue;
      const row = el("p");
      row.append(el("strong", "", label), el("span", "", labels.join(" / ")));
      mapping.append(row);
    }
    if (!mapping.childElementCount) mapping.textContent = "—";
    const limitations = Array.isArray(data.limitations) ? data.limitations.filter(item => typeof item === "string") : [];
    $("#model-limitations").textContent = limitations.join(" ") || "模型与加速状态由设备报告；不可用的信息显示为“—”。";
    diagnosticFeedback("#model-feedback", data.ready === true ? "" : data.ready === false ? "识别模型尚未就绪，可下载诊断日志查看加载情况。" : "模型运行状态暂不可用。", data.ready === false);
  }

  async function loadModelInfo() {
    const button = $("#refresh-model-info");
    if (button.disabled) return;
    button.disabled = true;
    try { renderModelInfo(await api("/api/diagnostics/model")); }
    catch (error) {
      renderModelInfo({});
      diagnosticFeedback("#model-feedback", `模型信息读取失败：${error.message}`, true);
    } finally { button.disabled = false; if(ui.onDiagnostics)ui.onDiagnostics(); }
  }

  async function loadLogs() {
    const button = $("#refresh-logs");
    if (button.disabled) return;
    button.disabled = true;
    try {
      const data = await api("/api/logs");
      state.logs=data;
      if (!Array.isArray(data.items)) throw new Error("设备未返回日志列表。");
      const fragment = document.createDocumentFragment();
      for (const item of data.items) {
        if (!item || typeof item !== "object") continue;
        const row = el("tr");
        row.append(el("td", "", item.name || "未命名日志"), el("td", "", bytesText(item.size_bytes)), el("td", "", dateText(item.modified_at)));
        fragment.append(row);
      }
      $("#logs-body").replaceChildren(fragment);
      if(ui.onDiagnostics)ui.onDiagnostics();
      $(".logs-table").hidden = !$("#logs-body").childElementCount;
      $("#logs-scope").textContent = data.scope || "下载设备日志与运行信息，用于分析采集、录像和识别问题。";
      const limit = metricNumber(data.max_bundle_bytes);
      $("#logs-note").textContent = `${limit !== null && limit > 0 ? `单次日志采集上限约 ${bytesText(limit)}。` : ""}下载内容为诊断压缩包；刷新日志不会改动尚未保存的通道设置。`;
      diagnosticFeedback("#logs-feedback", $("#logs-body").childElementCount ? "" : "暂无日志文件，仍可下载包含运行状态的诊断包。");
    } catch (error) { diagnosticFeedback("#logs-feedback", `日志列表读取失败：${error.message} 可以刷新重试。`, true); }
    finally { button.disabled = false; }
  }


  function loadDiagnostics() {
    state.nextDiagnosticsRefresh = Date.now() + 15000;
    return Promise.allSettled([loadModelInfo(), loadLogs()]);
  }

  function openMedia(type, value, title, metadata = {}) {
    const url = mediaUrl(value);
    if (!url) return toast("该媒体文件暂不可用。");
    const content = $("#media-content");
    content.className = type === "video" ? "player-content" : "image-content";
    content.replaceChildren();
    const media = el(type === "video" ? "video" : "img");
    if (type === "video") {
      media.controls = true;
      media.autoplay = true;
      media.playsInline = true;
      media.preload = "metadata";
    } else media.alt = title;
    media.src = url;
    media.addEventListener("error", () => { $("#media-note").textContent = "文件可能已被自动清理，或此浏览器不支持该编码。请刷新列表或下载录像。"; });
    content.append(media);
    if(type === "video") {
      const details=el("div","option-group");
      [["通道",metadata.channel_id?channelName(metadata.channel_id):title],["开始时间",dateText(metadata.created_at)],["片段时长",durationText(metadata.duration_seconds)],["文件大小",bytesText(metadata.size_bytes)]].forEach(([name,value])=>{const r=el("div","option-row");r.append(el("span","option-label",name),el("span","option-value",value));details.append(r);});
      content.append(details,downloadLink(value,"导出录像"));
    }
    $("#media-title").textContent = title;
    $("#media-note").replaceChildren();
    if(type === "video") $("#media-note").append(downloadLink(value,"导出录像"));
    const dialog = $("#media-dialog");
    if (!dialog.open) dialog.show();
  }

  function downloadLink(value, text = "下载") {
    const url = mediaUrl(value);
    if (!url) return el("span", "muted", "文件不可用");
    const link = el("a", "download-link", text);
    link.href = location.hostname === "127.0.0.1" ? `${url}${url.includes("?") ? "&" : "?"}download=1` : url;
    if (location.hostname !== "127.0.0.1") link.download = "";
    return link;
  }

  function renderRecordings(items) {
    const body = $("#recordings-body");
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const row = el("tr");
      const file = el("td");
      file.append(el("span", "", "▷  " + channelName(item.channel_id)));
      if (item.available === false) file.append(el("small", "", item.error || "录像介质尚未接入"));
      row.append(file, el("td", "", dateText(item.created_at)), el("td", "", durationText(item.duration_seconds)), el("td", "", bytesText(item.size_bytes)));
      const actions = el("td");
      const play = el("button", "button secondary small", "›");
      play.disabled = item.available === false || !mediaUrl(item.url);
      play.addEventListener("click", () => openMedia("video", item.url, `${channelName(item.channel_id)} · 录像回放`, item));
      actions.append(play);
      row.append(actions);
      fragment.append(row);
    }
    body.replaceChildren(fragment);
    $("#recording-count-label").textContent = `显示 ${items.length} 个片段`;
    $(".table-wrap").hidden = !items.length;
  }

  function renderEvents(items) {
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      // 旧版本记录均为停留事件；颜色类名只使用固定白名单。
      const type = Object.prototype.hasOwnProperty.call(eventNames, item.event_type) ? item.event_type : "dwell";
      const card = el("article", "event-card");
      const imageButton = el("button", "event-image-button");
      imageButton.setAttribute("aria-label", "查看事件截图");
      const url = mediaUrl(item.snapshot_url);
      if (url) {
        const picture = el("img");
        picture.src = url;
        picture.alt = `${channelName(item.channel_id)} 事件截图`;
        picture.loading = "lazy";
        picture.addEventListener("error", () => { imageButton.replaceChildren(el("span", "", "截图暂不可用")); });
        imageButton.append(picture);
        imageButton.addEventListener("click", () => ui.openEvent(item));
      } else { imageButton.textContent = "暂无截图"; imageButton.disabled = true; }
      const content = el("div", "event-content");
      const title = el("h3");
      const typeLabel = el("span", `event-label event-${type}`);
      const dot = el("span", "event-dot");
      dot.setAttribute("aria-hidden", "true");
      typeLabel.append(dot, el("span", "", eventNames[type]));
      title.append(typeLabel);
      const dwell = metricNumber(item.dwell_seconds);
      const badge = type === "dwell" ? `${categoryNames[item.category] || item.label || "目标"} · ${dwell !== null && dwell >= 0 ? `${dwell.toFixed(1)} 秒` : "已达阈值"}` : "首次确认";
      title.append(el("span", "event-detail", badge));
      content.append(title, el("p", "", `${channelName(item.channel_id)} · 录像回放`, item));
      const actions = el("div", "event-actions");
      actions.append(downloadLink(item.snapshot_url, "下载截图"));
      if (mediaUrl(item.recording_url)) {
        const play = el("button", "button secondary small", "查看录像");
        play.addEventListener("click", () => openMedia("video", item.recording_url, `${channelName(item.channel_id)} · 事件录像`));
        actions.append(play);
      } else actions.append(el("span", "muted", "录像完成后可关联"));
      content.append(actions);
      card.append(imageButton, content);
      card.onclick = () => ui.openEvent(item);
      fragment.append(card);
    }
    $("#events-grid").replaceChildren(fragment);
    $("#event-count-label").textContent = `显示 ${items.length} 条事件`;
  }

  async function loadList(kind, showLoading = false) {
    const sequence = ++state.requests[kind];
    const feedback = $(`#${kind}-feedback`);
    const filter = kind === "recordings" ? $("#recording-filter").value : $("#event-filter").value;
    const eventType = kind === "events" ? $("#event-type-filter").value : "";
    const query = new URLSearchParams();
    if (filter) query.set("channel_id", filter);
    if (eventType) query.set("event_type", eventType);
    if (showLoading) { feedback.hidden = false; feedback.className = "list-feedback"; feedback.textContent = "正在读取…"; }
    try {
      const data = await api(`/api/${kind}${query.toString() ? `?${query}` : ""}`);
      if (sequence !== state.requests[kind]) return;
      const items = Array.isArray(data.items) ? data.items : [];
      if (kind === "recordings") renderRecordings(items);
      else renderEvents(items);
      feedback.hidden = !!items.length;
      feedback.className = "list-feedback";
      feedback.textContent = kind === "recordings" ? "暂无已完成的录像。请开启通道录像，等待首个片段保存。" : filter || eventType ? "没有符合当前筛选条件的事件，可切换通道或事件类型。" : "暂无事件。检测到运动的人、车或动物时保存事件；仅人参与长时间停留检测，同一目标不重复新增。";
    } catch (error) {
      if (sequence !== state.requests[kind]) return;
      feedback.hidden = false;
      feedback.className = "list-feedback error";
      feedback.textContent = `${error.message} 可以点击刷新重试。`;
    }
  }

  function inputField(label, key, value, options = {}) {
    const wrapper = el("label", options.wide ? "wide" : "", label);
    const input = el("input");
    input.type = options.type || "text";
    input.dataset.key = key;
    input.value = value ?? "";
    for (const property of ["min", "max", "step", "maxLength", "placeholder", "list"]) {
      if (options[property] !== undefined) input.setAttribute(property, options[property]);
    }
    if (options.required !== false) input.required = true;
    wrapper.append(input);
    return wrapper;
  }

  function checkField(label, key, checked, className = "") {
    const wrapper = el("label", "check-label");
    const input = el("input", className);
    input.type = "checkbox";
    input.dataset.key = key;
    input.checked = checked === true;
    wrapper.append(input, el("span", "", label));
    return wrapper;
  }

  function sectionHeader(title, toggle) {
    const heading = el("div", "subsection-heading");
    heading.append(el("h3", "", title), toggle);
    return heading;
  }

  function renderStorageTargets(selectedId = $("#storage-target").value || "internal") {
    const select = $("#storage-target");
    const targets = state.storageTargets || [{id: "internal", label: "内置存储", available: true, writable: true}];
    select.replaceChildren();
    for (const target of targets) {
      const usable = target.available !== false && target.writable !== false;
      const option = el("option", "", `${target.label || (target.id === "internal" ? "内置存储" : "外部存储")}${!usable ? target.available === false ? " · 未就绪" : " · 只读" : metricNumber(target.free_bytes) !== null ? ` · 剩余 ${bytesText(target.free_bytes)}` : ""}`);
      option.value = target.id;
      option.disabled = !usable;
      select.append(option);
    }
    if (!targets.some(target => target.id === selectedId)) {
      const missing = el("option", "", selectedId === "internal" ? "内置存储 · 状态未知" : "已选外部存储 · 尚未接入");
      missing.value = selectedId;
      missing.disabled = true;
      select.append(missing);
    }
    select.value = selectedId;
    updateStorageTargetInfo();
  }

  function updateStorageTargetInfo() {
    const selectedId = $("#storage-target").value;
    const info = $("#storage-target-info");
    const target = state.storageTargets?.find(item => item.id === selectedId);
    const savedId = state.config?.storage?.target_id || "internal";
    info.classList.remove("error");
    if (state.storageTargetError) {
      info.textContent = `介质列表读取失败：${state.storageTargetError} 当前保存位置：${savedId === "internal" ? "内置存储" : "外部存储"}。请刷新后重试。`;
      info.classList.add("error");
    } else if (!state.storageTargets) {
      info.textContent = "正在读取存储介质…";
    } else if (!target || target.available === false || target.writable === false) {
      info.textContent = `${target?.label || "所选介质"}${target?.available !== false && target?.writable === false ? "为只读状态" : "尚未接入或未挂载"}。请接入可写介质后刷新，或选择内置存储。`;
      info.classList.add("error");
    } else {
      const noExternal = !state.storageTargets.some(item => item.id !== "internal" && item.available !== false);
      const context = selectedId === savedId ? "当前使用" : "保存后将使用";
      info.textContent = `${noExternal ? "未发现已挂载的 SD 卡或其他外部介质。" : ""}${context}${target.label || (selectedId === "internal" ? "内置存储" : "外部存储")}，剩余 ${bytesText(target.free_bytes)} / 总计 ${bytesText(target.total_bytes)}${target.filesystem ? ` · ${target.filesystem}` : ""}${target.mountpoint ? ` · ${target.mountpoint}` : ""}。`;
    }
  }

  async function loadStorageTargets() {
    const button = $("#refresh-storage-targets");
    if (button.disabled) return;
    button.disabled = true;
    try {
      const data = await api("/api/storage/targets");
      if (!Array.isArray(data.targets)) throw new Error("设备未返回存储介质列表。");
      state.storageTargets = data.targets.filter(target => target && typeof target.id === "string");
      state.storageTargetError = "";
      renderStorageTargets($("#storage-target").value || state.config?.storage?.target_id || data.selected_id || "internal");
      if (state.status) updateSystem(state.status);
    } catch (error) {
      state.storageTargetError = error.message;
      updateStorageTargetInfo();
    } finally { button.disabled = false; if(ui.onDiagnostics)ui.onDiagnostics(); }
  }

  function updateCopySelection() {
    const checks = $$("#copy-targets input");
    const selected = checks.filter(input => input.checked).length;
    $("#copy-select-all").checked = !!checks.length && selected === checks.length;
    $("#copy-select-all").indeterminate = selected > 0 && selected < checks.length;
    $("#apply-copy").disabled = !selected;
    $("#apply-copy").textContent = selected ? `复制到 ${selected} 个通道` : "复制到所选通道";
  }

  function openCopyDialog(sourceId) {
    if (!state.config || state.saving) return;
    state.copySourceId = String(sourceId);
    const sourceCard = $$("#channel-settings > .settings-card").find(card => card.dataset.channelId === state.copySourceId);
    const sourceName = sourceCard ? $('[data-key="name"]', sourceCard).value : channelName(sourceId);
    $("#copy-description").textContent = `将「${sourceName || `AHD ${sourceId}`}」的当前参数复制到其他通道。包含马赛克设置，开启后会严重降低性能，并永久写入新录像。`;
    const targets = $("#copy-targets");
    targets.replaceChildren();
    for (const card of $$("#channel-settings > .settings-card")) {
      if (card.dataset.channelId === state.copySourceId) continue;
      const name = $('[data-key="name"]', card).value || `AHD ${card.dataset.channelId}`;
      const label = checkField(`${card.dataset.channelId} · ${name}`, "copy-target", false);
      $("input", label).value = card.dataset.channelId;
      targets.append(label);
    }
    updateCopySelection();
    $("#copy-dialog").showModal();
  }

  function applyChannelCopy() {
    const ids = $$("#copy-targets input:checked").map(input => input.value);
    if (!ids.length || !state.copySourceId) return;
    const sourceCard = $$("#channel-settings > .settings-card").find(card => card.dataset.channelId === state.copySourceId);
    if (!sourceCard) return;
    for (const input of $$("input, select", sourceCard)) {
      if (!input.checkValidity()) { toast("来源通道存在无效参数，请先修正后再复制。"); return; }
    }
    try {
      const draft = readSettings(false);
      const source = draft.channels.find(channel => String(channel.id) === state.copySourceId);
      validateChannel(source);
      for (const channel of draft.channels) {
        if (!ids.includes(String(channel.id))) continue;
        // 白名单复制：接线 source / crop、身份 id / name 和通道 enabled 均保留。
        for (const key of ["width", "height", "fps", "preview_fps", "recording", "detection", "privacy"]) channel[key] = JSON.parse(JSON.stringify(source[key]));
      }
      renderSettings(draft, false);
      setDirty(true);
      $("#copy-dialog").close();
      settingsFeedback(`已将 AHD ${state.copySourceId} 的参数复制到 ${ids.length} 个通道的草稿，接线映射保持原样。点击“保存并应用”使修改生效。`);
      toast(`已复制到 ${ids.length} 个通道 · 等待保存`);
    } catch (error) { toast(error.message); }
  }

  function renderSettings(config, resetDirty = true) {
    const fragment = document.createDocumentFragment();
    for (const channel of config.channels || []) {
      const card = el("section", "settings-card");
      card.dataset.channelId = channel.id;
      const header = el("div", "settings-channel-header");
      const title = el("h2");
      title.append(el("span", "camera-number", String(channel.id).padStart(2, "0")), el("span", "", `AHD ${channel.id}`));
      const actions = el("div", "settings-channel-actions");
      const copy = el("button", "button secondary small", "应用到其他通道");
      copy.type = "button";
      copy.title = "复制参数，保留接线映射";
      copy.addEventListener("click", () => openCopyDialog(channel.id));
      actions.append(copy, checkField("启用通道", "enabled", channel.enabled, "channel-enabled"));
      header.append(title, actions);
      const basic = el("div", "form-grid");
      basic.append(inputField("通道名称", "name", channel.name, {maxLength: 40}), inputField("视频设备", "source", channel.source, {list: "device-options", placeholder: "/dev/video0"}), inputField("图像宽度（像素）", "width", channel.width, {type: "number", min: 160, max: 1920, step: 8}), inputField("图像高度（像素）", "height", channel.height, {type: "number", min: 120, max: 1080, step: 8}));
      const cropLabel = el("label", "", "画面区域");
      const cropSelect = el("select");
      cropSelect.dataset.key = "crop";
      for (const [label, crop] of cropChoices) { const option = el("option", "", label); option.value = JSON.stringify(crop); cropSelect.append(option); }
      const currentCrop = JSON.stringify(channel.crop || [0, 0, 1, 1]);
      if (!cropChoices.some(([, crop]) => JSON.stringify(crop) === currentCrop)) { const option = el("option", "", "当前自定义区域"); option.value = currentCrop; cropSelect.append(option); }
      cropSelect.value = currentCrop;
      cropLabel.append(cropSelect);
      basic.append(cropLabel);
      const recording = el("div", "subsection");
      recording.append(sectionHeader("连续录像", checkField("启用录像", "recording.enabled", channel.recording?.enabled)));
      const recordingGrid = el("div", "form-grid");
      const segmentLabel = el("label", "", "录像片段长度");
      const segment = el("select");
      segment.dataset.key = "recording.segment_minutes";
      for (const minutes of [...new Set([1, 3, 5, 10, channel.recording?.segment_minutes || 3])].sort((a, b) => a - b)) { const option = el("option", "", `${minutes} 分钟`); option.value = minutes; segment.append(option); }
      segment.value = channel.recording?.segment_minutes || 3;
      segmentLabel.append(segment);
      const fps = channel.fps ?? 25;
      recordingGrid.append(inputField("录像目标帧率（fps）", "fps", fps, {type: "number", min: 1, max: 30, step: 1}), inputField("预览目标帧率（fps）", "preview_fps", channel.preview_fps ?? Math.min(16, fps), {type: "number", min: 1, max: 30, step: 1}), segmentLabel);
      for (const [key, title] of [["plate_mosaic", "开启车牌马赛克"], ["face_mosaic", "开启人脸马赛克"]]) {
        const field = checkField(title, `privacy.${key}`, channel.privacy?.[key] || false);
        const input = field.querySelector('input');
        input.addEventListener('change', () => {
          if (!input.checked) return;
          input.checked = false;
          const dialog = el('dialog', 'choice-dialog');
          dialog.append(el('h2', '', '开启马赛克？'), el('p', 'footnote', '开启后会严重降低性能，可能降低预览与录像帧率。马赛克会永久写入新录像，不能恢复原画面；已有录像不会改变。采用间隔检测与逐帧跟踪，快速新目标可能短暂漏遮挡。'));
          const actions = el('div', 'dialog-actions');
          for (const [title, accept] of [['取消', false], ['仍然开启', true]]) {
            const button = el('button', 'button ' + (accept ? 'primary' : 'secondary'), title); button.type = 'button';
            button.onclick = () => { if (accept && input.isConnected) { input.checked = true; setDirty(true); } dialog.close(); };
            actions.append(button);
          }
          dialog.append(actions); dialog.onclose = () => dialog.remove(); document.body.append(dialog); dialog.showModal();
        });
        recordingGrid.append(field);
      }
      recording.append(recordingGrid, el("p", "footnote", "可设置 1–30 fps，预览目标不能高于录像目标。默认录像 25 fps、预览 16 fps；实际帧率受输入信号、设备负载与网络影响，可在实时画面查看。"));
      const detection = el("div", "subsection");
      detection.append(sectionHeader("智能侦测", checkField("启用侦测", "detection.enabled", channel.detection?.enabled)));
      const detectionGrid = el("div", "form-grid");
      const categories = el("div", "form-field wide");
      categories.append(el("span", "", "识别目标"));
      const checks = el("div", "category-options");
      for (const [key, label] of Object.entries(categoryNames)) checks.append(checkField(label, `category.${key}`, channel.detection?.categories?.includes(key)));
      categories.append(checks);
      detectionGrid.append(categories, inputField("人员停留阈值（秒）", "detection.threshold_seconds", channel.detection?.threshold_seconds ?? 3, {type: "number", min: 0.1, max: 3600, step: 0.1}), inputField("识别置信度（0—1）", "detection.confidence", channel.detection?.confidence ?? 0.35, {type: "number", min: 0.1, max: 0.99, step: 0.01}), inputField("侦测间隔（秒）", "detection.sample_interval", channel.detection?.sample_interval ?? 1, {type: "number", min: 0.2, max: 10, step: 0.1}), inputField("短暂消失容忍（秒）", "detection.lost_tolerance_seconds", channel.detection?.lost_tolerance_seconds ?? 2, {type: "number", min: 0.2, max: 30, step: 0.1}));
      detection.append(detectionGrid, el("p", "footnote", "运动的人、车、动物保存普通事件；仅人参与长时间停留检测，静止的人也可触发停留事件。同一目标持续出现只保存一条，人员停留达标更新原事件。目标离开超过消失容忍后再出现，按新目标确认。消失容忍至少为侦测间隔的 2.5 倍，以容忍一次漏检。默认置信度 0.35，调低可减少漏检，也可能增加误报。侦测间隔越短，处理负载越高。"));
      card.append(header, basic, el("p", "footnote", "AHD1 使用 /dev/video5 的完整画面。AHD2—5 共用 /dev/video0 的四个区域；接入其他摄像头后，可调整区域与插口的对应关系。"), recording, detection);
      fragment.append(card);
    }
    $("#channel-settings").replaceChildren(fragment);
    $("#storage-max-gb").value = config.storage?.max_gb ?? 20;
    $("#storage-min-free-gb").value = config.storage?.min_free_gb ?? 2;
    renderStorageTargets(config.storage?.target_id || "internal");
    if (resetDirty) setDirty(false);
    if(ui.onConfig) ui.onConfig();
    for (const filter of [$("#recording-filter"), $("#event-filter")]) {
      const selected = filter.value;
      filter.replaceChildren();
      const all = el("option", "", "全部通道"); all.value = ""; filter.append(all);
      for (const channel of config.channels || []) { const option = el("option", "", `${channel.id} · ${channel.name}`); option.value = channel.id; filter.append(option); }
      filter.value = selected;
    }
  }

  function settingsFeedback(message, error = false) {
    const feedback = $("#settings-feedback");
    feedback.hidden = !message;
    feedback.className = `banner${error ? " error" : ""}`;
    feedback.textContent = message;
  }

  function setDirty(dirty) {
    state.dirty = dirty;
    $(".save-bar").classList.toggle("dirty", dirty);
    $("#save-state").textContent = dirty ? "有尚未保存的修改" : state.config ? "所有设置已保存" : "设置尚未加载";
    $("#save-settings").disabled = !state.config || state.saving;
  }

  async function loadConfig(force = false) {
    if (state.dirty && !force) return;
    try {
      const config = await api("/api/config");
      if (state.dirty && !force) return;
      state.config = config;
      renderSettings(config);
      if (!state.storageTargets) loadStorageTargets();
      settingsFeedback("");
    } catch (error) { settingsFeedback(error.message, true); }
  }

  function validateChannel(channel) {
    if (!Number.isInteger(channel.fps) || channel.fps < 1 || channel.fps > 30) throw new Error(`AHD ${channel.id} 的录像目标帧率须为 1–30 的整数。`);
    if (!Number.isInteger(channel.preview_fps) || channel.preview_fps < 1 || channel.preview_fps > 30 || channel.preview_fps > channel.fps) throw new Error(`AHD ${channel.id} 的预览帧率须为 1–30 的整数，且不能高于录像目标帧率。`);
    if (channel.detection.lost_tolerance_seconds < channel.detection.sample_interval) throw new Error(`AHD ${channel.id} 的短暂消失容忍时间不能小于侦测间隔。`);
    if (channel.detection.enabled && !channel.detection.categories.length) throw new Error(`AHD ${channel.id} 已开启侦测，请至少选择一种识别目标。`);
  }

  function readSettings(validate = true) {
    const config = JSON.parse(JSON.stringify(state.config));
    for (const card of $$("#channel-settings > .settings-card")) {
      const channel = config.channels.find(item => String(item.id) === card.dataset.channelId);
      channel.recording = channel.recording || {};
      channel.privacy = channel.privacy || {face_mosaic: false, plate_mosaic: false};
      channel.detection = channel.detection || {};
      channel.detection.categories = [];
      for (const input of $$("[data-key]", card)) {
        const key = input.dataset.key;
        if (key === "crop") { channel.crop = JSON.parse(input.value); continue; }
        if (key.startsWith("category.")) { if (input.checked) channel.detection.categories.push(key.split(".")[1]); continue; }
        const value = input.type === "checkbox" ? input.checked : input.type === "number" || key === "recording.segment_minutes" ? Number(input.value) : input.value.trim();
        const parts = key.split(".");
        if (parts.length === 2) channel[parts[0]][parts[1]] = value;
        else channel[key] = value;
      }
      if (validate) validateChannel(channel);
    }
    const targetId = $("#storage-target").value;
    if (validate && targetId !== (state.config.storage?.target_id || "internal")) {
      const target = state.storageTargets?.find(item => item.id === targetId);
      if (!target || target.available === false || target.writable === false) throw new Error("所选录像介质当前不可用，请刷新介质列表后重试。");
    }
    config.storage = {...config.storage, target_id: targetId, max_gb: Number($("#storage-max-gb").value), min_free_gb: Number($("#storage-min-free-gb").value)};
    return config;
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (!state.config || state.saving) return;
    const invalid = Array.from($("#settings-form").elements).find(input => input.willValidate && !input.validity.valid);
    if(invalid){if(ui.onInvalid)ui.onInvalid(invalid);return;}
    let config;
    try { config = readSettings(); } catch (error) { settingsFeedback(error.message, true); return; }
    state.saving = true;
    $("#save-settings").textContent = "正在保存…";
    $("#settings-form").classList.add("saving");
    setDirty(state.dirty);
    try {
      const fresh = await api("/api/config");
      config = mergeChanges(state.config, config, fresh);
      config.channels.forEach(validateChannel);
      const response = await api("/api/config", {method: "PUT", body: JSON.stringify(config)});
      if (!response.ok) throw new Error(response.error || "保存未成功，请重试。");
      state.config = response.config || config;
      renderSettings(state.config);
      settingsFeedback("设置已保存并应用。受影响的通道可能需要几秒重新连接。");
      toast("设置已保存");
      syncStreams(true);
    } catch (error) { settingsFeedback(error.message, true); }
    finally {
      state.saving = false;
      $("#settings-form").classList.remove("saving");
      $("#save-settings").textContent = "保存并应用";
      setDirty(state.dirty);
    }
  }

  async function loadDevices() {
    const button = $("#refresh-devices");
    button.disabled = true;
    try {
      const data = await api("/api/devices");
      const devices = Array.isArray(data.devices) ? data.devices : [];
      $("#device-options").replaceChildren();
      for (const device of devices) { const option = el("option"); option.value = device.path; option.label = device.name || device.path; $("#device-options").append(option); }
      $("#devices-summary").textContent = devices.length ? `检测到 ${devices.length} 个设备：${devices.map(device => `${device.path}${device.name ? `（${device.name}）` : ""}`).join("、")}。设备节点与 AHD 插口的对应关系请以实际画面为准。` : "未发现视频设备。请检查驱动与连接；也可以手动填写设备路径。";
    } catch (error) { $("#devices-summary").textContent = error.message; }
    finally { button.disabled = false; }
  }

  buildCameras();
  Object.assign(ui, {state,el,api,toast,mediaUrl,bytesText,dateText,downloadLink,setPage,openCopyDialog,stopStream,openMedia});
  installHostUI(ui);
  $("#server-address").textContent = location.host;
  setDirty(false);
  $$(".nav-button").forEach(button => button.addEventListener("click", () => setPage(button.dataset.page)));
  window.addEventListener("hashchange", () => setPage(location.hash.slice(1), false));
  $("#reconnect-streams").addEventListener("click", () => { syncStreams(true); if (!state.pollBusy) poll(); toast("正在重新连接各路画面"); });
  $("#refresh-recordings").addEventListener("click", () => loadList("recordings", true));
  $("#refresh-events").addEventListener("click", () => loadList("events", true));
  $("#recording-filter").addEventListener("change", () => loadList("recordings", true));
  $("#event-filter").addEventListener("change", () => loadList("events", true));
  $("#event-type-filter").addEventListener("change", () => loadList("events", true));
  $("#refresh-devices").addEventListener("click", loadDevices);
  $("#refresh-model-info").addEventListener("click", loadModelInfo);
  $("#refresh-logs").addEventListener("click", loadLogs);

  $("#refresh-storage-targets").addEventListener("click", loadStorageTargets);
  $("#storage-target").addEventListener("change", updateStorageTargetInfo);
  $("#copy-targets").addEventListener("change", updateCopySelection);
  $("#copy-select-all").addEventListener("change", () => {
    for (const input of $$("#copy-targets input")) input.checked = $("#copy-select-all").checked;
    updateCopySelection();
  });
  $("#apply-copy").addEventListener("click", applyChannelCopy);
  for (const selector of ["#close-copy", "#cancel-copy"]) $(selector).addEventListener("click", () => $("#copy-dialog").close());
  $("#copy-dialog").addEventListener("close", () => { state.copySourceId = null; });
  $("#settings-form").addEventListener("input", () => { if (state.config) setDirty(true); });
  $("#settings-form").addEventListener("change", () => { if (state.config) setDirty(true); });
  $("#settings-form").addEventListener("submit", saveSettings);
  $("#reload-settings").addEventListener("click", () => {
    if (state.config) { renderSettings(state.config); settingsFeedback("已恢复到上次保存的设置。"); }
    else loadConfig(true);
  });
  $("#close-media").addEventListener("click", () => $("#media-dialog").close());
  $("#media-dialog").addEventListener("close", () => {
    const video = $("video", $("#media-content"));
    if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
    $("#media-content").replaceChildren();
  });
  document.addEventListener("visibilitychange", () => {
    clearTimeout(state.timer);
    syncStreams(true);
    if (!document.hidden && !state.pollBusy) poll();
  });
  window.addEventListener("beforeunload", event => { if (state.dirty) { event.preventDefault(); event.returnValue = ""; } });
  window.addEventListener("pagehide", () => { clearTimeout(state.timer); for (const card of state.cards.values()) stopStream(card); });
  window.addEventListener("pageshow", event => { if (event.persisted && !state.pollBusy) poll(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape") for (const card of $$(".camera-expanded")) card.classList.remove("camera-expanded"); });
  window.addEventListener("resize", () => { for (const card of state.cards.values()) positionBoxes(card); });
  function updateClock() { $("#clock").textContent = new Date().toLocaleString("zh-CN", {hour12: false}); }
  updateClock();
  setInterval(updateClock, 1000);
  setPage(location.hash.slice(1) || "live", false);
  loadDevices();
  poll();
})();
