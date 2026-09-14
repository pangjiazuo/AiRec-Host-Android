(() => {
  // web-src/timeline.js
  function dayWindow(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("\u65E5\u671F\u65E0\u6548");
    const parts = value.split("-").map(Number);
    const start = new Date(parts[0], parts[1] - 1, parts[2]);
    const end = new Date(parts[0], parts[1] - 1, parts[2] + 1);
    if (!Number.isFinite(+start) || start.getFullYear() !== parts[0] || start.getMonth() !== parts[1] - 1 || start.getDate() !== parts[2]) throw new Error("\u65E5\u671F\u65E0\u6548");
    return { start: +start, end: +end };
  }
  function decodeIndex(data, channel, day, mediaUrl) {
    if (!Array.isArray(data.recordings) || !Array.isArray(data.event_segments) || Date.parse(data.start) !== day.start || Date.parse(data.end) !== day.end) throw new Error("\u5168\u5929\u5F55\u50CF\u7D22\u5F15\u4E0D\u5B8C\u6574\uFF0C\u8BF7\u91CD\u8BD5");
    const recordings = data.recordings.filter((r) => r.available).map((r) => {
      const start = Date.parse(r.created_at), end = start + Number(r.duration_seconds) * 1e3;
      const url = mediaUrl(r.url);
      if (Number(r.channel_id) !== channel || !Number.isFinite(end) || end <= start || !url) throw new Error("\u5F55\u50CF\u7D22\u5F15\u6570\u636E\u65E0\u6548");
      return { ...r, start, end, url };
    }).filter((r) => r.start < day.end && r.end > day.start).sort((a, b) => a.start - b.start);
    const events = data.event_segments.map((r) => ({ start: Date.parse(r.start), end: Date.parse(r.end), type: r.event_type })).filter((r) => Number.isFinite(r.start) && r.end > r.start && ["person", "vehicle", "animal", "dwell"].includes(r.type));
    return { recordings, events };
  }
  function atTime(recordings, time) {
    return recordings.find((r) => r.start <= time && time < r.end) || null;
  }
  function mergeChanges(original, draft, fresh) {
    if (JSON.stringify(original) === JSON.stringify(draft)) return fresh;
    if (Array.isArray(draft)) {
      if (draft.every((r) => r && typeof r === "object" && "id" in r)) return fresh.map((r) => {
        const old = original.find((v) => v.id === r.id), next = draft.find((v) => v.id === r.id);
        return old && next ? mergeChanges(old, next, r) : r;
      });
      return draft;
    }
    if (draft && typeof draft === "object") {
      const result = { ...fresh };
      Object.keys(draft).forEach((k) => {
        result[k] = mergeChanges(original && original[k], draft[k], fresh && fresh[k]);
      });
      return result;
    }
    return draft;
  }

  // web-src/native-preview.js
  var nativePreview = typeof HostControl !== "undefined" && typeof HostControl.nativePreview === "function" && HostControl.nativePreview();
  if (nativePreview) {
    const sync = () => {
      const items = [];
      const modal = !!document.querySelector("dialog[open]");
      document.querySelectorAll("img[data-native-channel]").forEach((img) => {
        if (modal && !document.hidden && !img.hidden && img.getClientRects().length && !img.getAttribute("src"))
          img.src = "/api/snapshot/" + img.dataset.nativeChannel + ".jpg";
        else if (!modal && img.getAttribute("src")) img.removeAttribute("src");
      });
      if (!document.hidden && !modal) {
        document.querySelectorAll("img[data-native-channel]").forEach((img) => {
          if (img.hidden || !img.getClientRects().length) return;
          const r = img.getBoundingClientRect();
          if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) return;
          const w = Math.min(r.width, r.height * 16 / 9), h = w * 9 / 16;
          const x = r.left + (r.width - w) / 2, y = r.top + (r.height - h) / 2;
          const buttons = Array.from(img.parentElement.querySelectorAll(".video-tools button")).filter((b) => b.getClientRects().length).map((b) => {
            const p = b.getBoundingClientRect();
            return { text: b.textContent, x: (p.left - x) / w, y: (p.top - y) / h, w: p.width / w, h: p.height / h };
          });
          items.push({
            id: Number(img.dataset.nativeChannel),
            x,
            y,
            w,
            h,
            buttons,
            radius: img.closest(".detail-fullscreen") ? 0 : 12,
            labels: img.classList.contains("camera-image")
          });
        });
      }
      HostControl.previewLayout(JSON.stringify({ width: innerWidth, items }));
    };
    setInterval(sync, 250);
    addEventListener("resize", sync);
    document.addEventListener("visibilitychange", sync);
    document.addEventListener("click", () => setTimeout(sync, 0), true);
  }

  // web-src/host-ui.js
  function installHostUI(core) {
    const { state, el, api, toast, mediaUrl, bytesText, dateText, downloadLink } = core;
    const $ = (s) => document.querySelector(s), $$ = (s) => Array.from(document.querySelectorAll(s));
    let selectedLog = null;
    let route = "home", channel = 1, detail = false, archive = false, sequence = 0, eventSequence = 0, scrollTimer;
    let day, index = { recordings: [], events: [] }, selectedTime = 0, currentClip = null, precise = false;
    const names = { home: "\u8BBE\u5907\u8BBE\u7F6E", channels: "\u901A\u9053\u7BA1\u7406", device: "\u8BBE\u5907\u4FE1\u606F", service: "\u672C\u5730\u670D\u52A1", storage: "\u5F55\u50CF\u5B58\u50A8", model: "\u8BC6\u522B\u6A21\u578B", logs: "\u65E5\u5FD7\u4E0E\u8BCA\u65AD", logDetail: "\u65E5\u5FD7\u8BE6\u60C5", licenses: "\u7B2C\u4E09\u65B9\u7EC4\u4EF6\u4E0E\u8BB8\u53EF", appearance: "\u5916\u89C2\u4E0E\u663E\u793A", about: "\u5173\u4E8E AiRec", channel: "\u901A\u9053\u8BBE\u7F6E", basic: "\u901A\u9053\u4FE1\u606F", image: "\u56FE\u50CF\u8BBE\u7F6E", recording: "\u5F55\u50CF\u8BBE\u7F6E", detection: "\u667A\u80FD\u4FA6\u6D4B", categories: "\u8BC6\u522B\u7C7B\u522B", dwell: "\u505C\u7559\u68C0\u6D4B", confidence: "\u8BC6\u522B\u7F6E\u4FE1\u5EA6", advanced: "\u9AD8\u7EA7\u53C2\u6570" };
    const parents = { logDetail: "logs", licenses: "about", basic: "channel", image: "channel", recording: "channel", detection: "channel", categories: "detection", dwell: "detection", confidence: "detection", advanced: "detection", channel: "channels" };
    const channelRoutes = ["channel", "basic", "image", "recording", "detection", "categories", "dwell", "confidence", "advanced"];
    const button = (text, action, style = "secondary") => {
      const b = el("button", "button " + style, text);
      b.type = "button";
      b.onclick = action;
      return b;
    };
    const row = (label, value = "", action = null, hint = "") => {
      const r = el(action ? "button" : "div", "option-row");
      if (action) {
        r.type = "button";
        r.onclick = action;
      }
      const left = el("span", "option-label", label);
      if (hint) left.append(el("small", "", hint));
      r.append(left, el("span", "option-value", value));
      if (action) r.append(el("span", "chevron", "\u203A"));
      return r;
    };
    const group = (...children) => {
      const g = el("section", "option-group");
      g.append(...children);
      return g;
    };
    const note = (text) => el("p", "footnote", text);
    function choiceDialog(select, title2) {
      const dialog = el("dialog", "choice-dialog"), options = group();
      let chosen = select.value;
      dialog.append(el("h2", "", title2));
      Array.from(select.options).forEach((option) => {
        const r = row(option.text, "", () => {
          chosen = option.value;
          Array.from(options.querySelectorAll("input")).forEach((n) => n.checked = n.value === chosen);
        });
        const radio = el("input");
        radio.type = "radio";
        radio.name = "host-choice";
        radio.value = option.value;
        radio.checked = chosen === option.value;
        r.append(radio);
        options.append(r);
      });
      const actions = el("div", "dialog-actions");
      actions.append(button("\u53D6\u6D88", () => dialog.close()), button("\u786E\u5B9A", () => {
        select.value = chosen;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        dialog.close();
      }, "primary"));
      dialog.append(options, actions);
      dialog.onclose = () => dialog.remove();
      document.body.append(dialog);
      dialog.showModal();
    }
    function confirmStop() {
      const dialog = el("dialog", "stop-dialog");
      dialog.append(el("h2", "", "\u505C\u6B62\u5F55\u50CF\uFF1F"), note("\u5F53\u524D\u7247\u6BB5\u4F1A\u5148\u4FDD\u5B58\uFF0C\u518D\u505C\u6B62\u91C7\u96C6\u3001\u8BC6\u522B\u548C\u5C40\u57DF\u7F51\u670D\u52A1\u3002\u5DF2\u6709\u5F55\u50CF\u548C\u8BBE\u7F6E\u4FDD\u7559\u3002"));
      const actions = el("div", "dialog-actions");
      actions.append(button("\u7EE7\u7EED\u5F55\u50CF", () => dialog.close()), button("\u505C\u6B62\u5F55\u50CF", () => {
        dialog.close();
        HostControl.stop();
      }, "primary"));
      dialog.append(actions);
      dialog.onclose = () => dialog.remove();
      document.body.append(dialog);
      dialog.showModal();
    }
    let exportBackground = false;
    function exportState(data) {
      if (data.phase === "running" && data.received === 0 && data.total === -1) exportBackground = false;
      let dialog = $("#host-export");
      if (!dialog) {
        dialog = el("dialog");
        dialog.id = "host-export";
        dialog.onclose = () => {
          exportBackground = true;
        };
        document.body.append(dialog);
      }
      dialog.replaceChildren(el("h2", "", data.label || "\u5BFC\u51FA\u6587\u4EF6"), note(data.phase === "done" ? "\u6587\u4EF6\u5DF2\u5BFC\u51FA" : data.phase === "failed" ? "\u5BFC\u51FA\u5931\u8D25" : "\u6B63\u5728\u5BFC\u51FA\u6587\u4EF6"));
      if (data.phase === "running") {
        const progress = el("progress");
        progress.max = data.total > 0 ? data.total : 1;
        if (data.total > 0) progress.value = data.received;
        dialog.append(progress, note(bytesText(data.received) + (data.total > 0 ? " / " + bytesText(data.total) : "")));
      }
      if (data.message) dialog.append(note(data.message));
      const actions = el("div", "dialog-actions");
      actions.append(button(data.phase === "running" ? "\u540E\u53F0\u7EE7\u7EED" : "\u5173\u95ED", () => dialog.close()));
      dialog.append(actions);
      if (!dialog.open && !exportBackground) dialog.showModal();
    }
    function go(name) {
      route = name;
      core.setPage("settings");
      renderRoute();
    }
    function showTheme(mode) {
      if (!["light", "dark", "system"].includes(mode)) mode = "light";
      try {
        localStorage.setItem("airec-theme", mode);
      } catch (e) {
      }
      const dark = mode === "dark" || mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.classList.toggle("dark", dark);
      if (window.HostControl) HostControl.theme(dark);
    }
    let theme = "light";
    try {
      theme = localStorage.getItem("airec-theme") || "light";
    } catch (e) {
    }
    showTheme(theme);
    const preference = matchMedia("(prefers-color-scheme: dark)");
    preference.addListener(() => {
      if (theme === "system") showTheme(theme);
    });
    const brand = $(".brand");
    brand.querySelector("span:last-child").textContent = "AiRec";
    const top = $(".topbar");
    top.querySelector(".breadcrumb").textContent = "AiRec \xB7 \u5F55\u50CF\u4E3B\u673A";
    const pageLabel = el("span", "sr-only");
    pageLabel.id = "page-label";
    top.append(pageLabel);
    const icons = [
      '<rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10 5-3v10l-5-3"/>',
      '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4z"/>',
      '<path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 21h4"/>',
      '<circle cx="12" cy="12" r="4"/><path d="m9 3 6 0 1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z"/>'
    ];
    $$(".nav-button").forEach((b, i) => {
      b.lastChild.textContent = ["\u5B9E\u65F6", "\u56DE\u653E", "\u4E8B\u4EF6", "\u8BBE\u7F6E"][i];
      b.querySelector("svg").innerHTML = icons[i];
    });
    const smallFeeds = el("div", "small-feeds");
    Array.from(state.cards.values()).slice(1).forEach((card) => smallFeeds.append(card.node));
    $("#camera-grid").append(smallFeeds);
    state.cards.forEach((card) => {
      const placeholder = card.placeholder.querySelector(".placeholder-icon");
      placeholder.innerHTML = '<svg viewBox="0 0 24 24"><path d="m3 3 18 18M6 6H4v12h12v-2m0-6V6h-5m5 5 5-3v9l-3-2"/></svg>';
    });
    $(".stats-grid").hidden = true;
    const live = $("#page-live"), heading = $(".section-heading");
    const title = el("div");
    title.append(el("h2", "", "\u5B9E\u65F6\u9884\u89C8"));
    const subtitle = el("p", "muted");
    subtitle.id = "live-summary";
    title.append(subtitle);
    const reconnect = $("#reconnect-streams");
    heading.replaceChildren(title, button("\u67E5\u770B\u8BBE\u5907", () => go("device")));
    if (reconnect) heading.append(reconnect);
    live.prepend(heading);
    Array.from(live.children).filter((n) => n.classList.contains("footnote")).forEach((n) => n.remove());
    const system = $(".system-panel");
    live.append(system);
    const serviceState = el("div", "service-empty");
    serviceState.hidden = true;
    live.append(serviceState);
    const statusFoot = el("p", "footnote", "\u65E0\u4FE1\u53F7\u901A\u9053\u72EC\u7ACB\u7B49\u5F85\uFF0C\u5176\u4ED6\u901A\u9053\u7EE7\u7EED\u5F55\u50CF\u3002");
    live.append(statusFoot);
    const settings = $("#page-settings"), menu = el("div", "settings-menu"), subhead = el("div", "workspace-head");
    const back = button("\u2039", () => backPage());
    back.setAttribute("aria-label", "\u8FD4\u56DE");
    const titleNode = el("h2", "", "\u8BBE\u5907\u8BBE\u7F6E");
    subhead.append(back, titleNode);
    settings.prepend(subhead, menu);
    const systemClone = el("div");
    systemClone.id = "device-details";
    settings.append(systemClone);
    const channelMenu = el("div");
    channelMenu.id = "channel-menu";
    $("#settings-form").prepend(channelMenu);
    $(".device-note").hidden = true;
    $("#storage-target").onmousedown = (e) => {
      e.preventDefault();
      choiceDialog(e.currentTarget, "\u4FDD\u5B58\u4ECB\u8D28");
    };
    $("#storage-target").onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        choiceDialog(e.currentTarget, "\u4FDD\u5B58\u4ECB\u8D28");
      }
    };
    const storageCard = $(".storage-settings"), storageGrid = el("div", "storage-columns");
    const storageLeft = group($("#storage-target").closest("label"));
    const totalStorage = row("\u603B\u5BB9\u91CF", "\u2014"), freeStorage = row("\u5F53\u524D\u53EF\u7528", "\u2014");
    storageLeft.append(totalStorage, freeStorage);
    const storageRight = group($("#storage-max-gb").closest("label"), $("#storage-min-free-gb").closest("label"), row("\u7A7A\u95F4\u4E0D\u8DB3\u65F6", "\u81EA\u52A8\u5220\u9664\u6700\u65E7\u5F55\u50CF\u4E0E\u4E8B\u4EF6"));
    const storageUsage = el("progress", "storage-progress");
    storageUsage.max = 100;
    const leftColumn = el("div");
    leftColumn.append(storageLeft, storageUsage, $("#refresh-storage-targets"));
    const rightColumn = el("div");
    rightColumn.append(storageRight, note("\u5FAA\u73AF\u6E05\u7406\u4EC5\u9488\u5BF9\u672C\u5E94\u7528\u4FDD\u5B58\u7684\u6587\u4EF6\u3002\u5916\u7F6E\u5B58\u50A8\u9700\u8981\u53EF\u5199\u540E\u624D\u80FD\u9009\u62E9\u3002"));
    const targetInfo = $("#storage-target-info");
    targetInfo.hidden = true;
    storageGrid.append(leftColumn, rightColumn);
    storageCard.replaceChildren(storageGrid, targetInfo);
    ["recordings", "events"].forEach((name) => $("#page-" + name).prepend(el("h2", "list-title", name === "recordings" ? "\u5F55\u50CF\u56DE\u653E" : "\u667A\u80FD\u4E8B\u4EF6")));
    const typeSelect = $("#event-type-filter");
    typeSelect.parentElement.hidden = true;
    const eventChips = el("div", "chips");
    ["", "dwell", "person", "vehicle", "animal"].forEach((value, i) => {
      const b = button(["\u5168\u90E8", "\u957F\u65F6\u95F4\u505C\u7559", "\u4EBA", "\u8F66", "\u52A8\u7269"][i], () => {
        typeSelect.value = value;
        typeSelect.dispatchEvent(new Event("change"));
        Array.from(eventChips.children).forEach((c) => c.classList.toggle("selected", c === b));
      });
      if (!i) b.classList.add("selected");
      eventChips.append(b);
    });
    $("#events-grid").before(eventChips);
    ["recordings", "events"].forEach((name) => {
      const page = $("#page-" + name), title2 = page.querySelector(".list-title"), toolbar = page.querySelector(".toolbar"), head = el("div", "history-head");
      toolbar.querySelectorAll("label").forEach((label) => Array.from(label.childNodes).forEach((n) => {
        if (n.nodeType === 3) n.textContent = "";
      }));
      page.prepend(head);
      head.append(title2, toolbar);
    });
    function configureCards() {
      $$("#channel-settings>.settings-card").forEach((card) => {
        if (card.dataset.grouped) return;
        card.dataset.grouped = "1";
        const fields = Array.from(card.querySelectorAll("[data-key]"));
        const panels = {};
        ["basic", "image", "recording", "detection", "categories", "dwell", "confidence", "advanced", "channel"].forEach((key) => {
          const panel = el("div", "field-panel");
          panel.dataset.panel = key;
          panels[key] = panel;
        });
        const map = { name: "basic", source: "basic", crop: "basic", width: "image", height: "image", preview_fps: "image", fps: "recording", "recording.enabled": "recording", "recording.segment_minutes": "recording", enabled: "channel", "detection.enabled": "detection", "detection.threshold_seconds": "dwell", "detection.confidence": "confidence", "detection.sample_interval": "advanced", "detection.lost_tolerance_seconds": "advanced" };
        fields.forEach((input) => {
          const key = input.dataset.key;
          const label = input.closest("label");
          if (label) panels[key.startsWith("category.") ? "categories" : map[key]].append(label);
        });
        card.replaceChildren(...Object.values(panels));
        const segment = card.querySelector('[data-key="recording.segment_minutes"]');
        segment.onmousedown = (e) => {
          e.preventDefault();
          choiceDialog(segment, "\u5F55\u50CF\u7247\u6BB5\u65F6\u957F");
        };
        segment.onkeydown = (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            choiceDialog(segment, "\u5F55\u50CF\u7247\u6BB5\u65F6\u957F");
          }
        };
        panels.basic.append(note("\u89C6\u9891\u6765\u6E90\u4E0E\u753B\u9762\u533A\u57DF\u51B3\u5B9A\u63A5\u7EBF\u6620\u5C04\uFF0C\u8BF7\u6309\u5B9E\u9645\u677F\u5361\u914D\u7F6E\u3002"));
        panels.dwell.prepend(row("\u68C0\u6D4B\u5BF9\u8C61", "\u4EC5\u4EBA"));
        panels.dwell.append(note("\u4EC5\u4EBA\u53C2\u4E0E\u505C\u7559\u68C0\u6D4B\uFF1B\u4EBA\u3001\u8F66\u3001\u52A8\u7269\u7684\u666E\u901A\u4E8B\u4EF6\u9700\u68C0\u6D4B\u5230\u76EE\u6807\u8FD0\u52A8\u3002"));
        panels.recording.append(row("\u89C6\u9891\u7F16\u7801", "H.264"), note("\u5B9E\u9645\u5E27\u7387\u53D7\u91C7\u96C6\u548C\u7F16\u7801\u8D1F\u8F7D\u5F71\u54CD\u3002"));
      });
      renderRoute();
    }
    function renderRoute() {
      if (state.page !== "settings") return;
      if (route === "storage") {
        const st = state.status && state.status.storage || {};
        totalStorage.querySelector(".option-value").textContent = bytesText(st.total_bytes);
        freeStorage.querySelector(".option-value").textContent = bytesText(st.free_bytes);
        storageUsage.value = st.total_bytes ? 100 * (1 - st.free_bytes / st.total_bytes) : 0;
      }
      $("#settings-form").className = "route-" + route;
      menu.dataset.route = route;
      titleNode.textContent = names[route];
      back.hidden = route === "home";
      menu.replaceChildren();
      channelMenu.replaceChildren();
      systemClone.replaceChildren();
      $(".model-settings").hidden = true;
      $(".diagnostics-settings").hidden = true;
      $("#settings-form").hidden = !(route === "storage" || channelRoutes.includes(route));
      $(".storage-settings").hidden = route !== "storage";
      $$("#channel-settings>.settings-card").forEach((card) => {
        card.hidden = !channelRoutes.includes(route) || Number(card.dataset.channelId) !== channel;
        Array.from(card.querySelectorAll("[data-panel]")).forEach((p) => p.hidden = p.dataset.panel !== route);
      });
      $(".save-bar").hidden = !(route === "storage" || channelRoutes.includes(route));
      if (route === "home") {
        menu.className = "settings-menu two-columns home-menu";
        menu.append(
          group(row("\u5F55\u50CF\u4E3B\u673A", "RK3399PRO", () => go("device"), "\u8BBE\u5907\u4FE1\u606F\u3001\u8FD0\u884C\u72B6\u6001"), row("\u672C\u5730\u670D\u52A1", state.connected ? "\u8FD0\u884C\u4E2D" : "\u672A\u8FDE\u63A5", () => go("service"), "\u542F\u52A8\u3001\u505C\u6B62\u4E0E\u5F00\u673A\u6062\u590D")),
          group(row("\u5F55\u50CF\u5B58\u50A8", state.status && state.status.storage && state.status.storage.label || "\u4FDD\u5B58\u4ECB\u8D28", () => go("storage"), "\u4FDD\u5B58\u4ECB\u8D28\u4E0E\u5FAA\u73AF\u5F55\u50CF"), row("\u901A\u9053\u7BA1\u7406", "5 \u8DEF", () => go("channels"), "\u56FE\u50CF\u3001\u5F55\u50CF\u4E0E\u667A\u80FD\u4FA6\u6D4B")),
          group(row("\u8BC6\u522B\u6A21\u578B", "YOLOv5s", () => go("model"), "NPU \u63A8\u7406\u4E0E\u76EE\u6807\u8DDF\u8E2A"), row("\u65E5\u5FD7\u4E0E\u8BCA\u65AD", "", () => go("logs"), "\u67E5\u770B\u4E0E\u5BFC\u51FA\u65E5\u5FD7")),
          group(row("\u5916\u89C2\u4E0E\u663E\u793A", { light: "\u6D45\u8272", dark: "\u6DF1\u8272", system: "\u8DDF\u968F\u7CFB\u7EDF" }[theme], () => go("appearance")), row("\u5173\u4E8E AiRec", "\u5B89\u5353\u5F55\u50CF\u4E3B\u673A", () => go("about")))
        );
      } else {
        menu.className = "settings-menu form-width";
        if (route === "channels") menu.append(group(...[1, 2, 3, 4, 5].map((id) => row("AHD" + id, "\u56FE\u50CF\u3001\u5F55\u50CF\u4E0E\u4FA6\u6D4B", () => {
          channel = id;
          go("channel");
        }))));
        if (route === "channel") {
          const original = $('[data-channel-id="' + channel + '"] [data-key=enabled]');
          const enabledRow = row("\u542F\u7528\u901A\u9053"), toggle = el("input");
          toggle.type = "checkbox";
          toggle.checked = original.checked;
          toggle.onchange = () => {
            original.checked = toggle.checked;
            original.dispatchEvent(new Event("change", { bubbles: true }));
          };
          enabledRow.append(toggle);
          channelMenu.append(
            group(row("\u901A\u9053\u4FE1\u606F", "AHD" + channel, () => go("basic")), enabledRow, row("\u56FE\u50CF\u8BBE\u7F6E", "\u5206\u8FA8\u7387\u4E0E\u9884\u89C8", () => go("image")), row("\u667A\u80FD\u4FA6\u6D4B", "\u7C7B\u522B\u4E0E\u505C\u7559\u9608\u503C", () => go("detection"))),
            group(row("\u5F55\u50CF\u8BBE\u7F6E", "\u8FDE\u7EED\u5F55\u50CF\u4E0E\u5206\u6BB5", () => go("recording")), row("\u5E94\u7528\u5230\u5176\u4ED6\u901A\u9053", "\u4FDD\u7559\u76EE\u6807\u901A\u9053\u540D\u79F0\u4E0E\u63A5\u7EBF", () => core.openCopyDialog(channel)))
          );
        }
        if (route === "detection") channelMenu.append(group(row("\u8BC6\u522B\u7C7B\u522B", "\u4EBA\u3001\u8F66\u3001\u52A8\u7269", () => go("categories")), row("\u505C\u7559\u68C0\u6D4B", "\u4EC5\u4EBA", () => go("dwell")), row("\u8BC6\u522B\u7F6E\u4FE1\u5EA6", "", () => go("confidence")), row("\u9AD8\u7EA7\u53C2\u6570", "\u68C0\u6D4B\u95F4\u9694\u3001\u6D88\u5931\u5BB9\u5FCD", () => go("advanced"))));
        if (route === "device") renderDevice();
        if (route === "model") renderModel();
        if (route === "logs") renderLogs();
        if (route === "logDetail") menu.append(group(row("\u6587\u4EF6\u540D", selectedLog.name), row("\u5927\u5C0F", bytesText(selectedLog.size_bytes)), row("\u6700\u540E\u66F4\u65B0", dateText(selectedLog.modified_at))), note("\u5BFC\u51FA\u8BCA\u65AD\u5305\u540E\u53EF\u5728\u7535\u8111\u4E0A\u67E5\u770B\u5B8C\u6574\u65E5\u5FD7\u3002"), downloadLink("/api/logs/download", "\u5BFC\u51FA\u8BCA\u65AD\u5305"));
        if (route === "appearance") menu.append(group(...["system", "light", "dark"].map((m) => row({ system: "\u8DDF\u968F\u7CFB\u7EDF", light: "\u6D45\u8272", dark: "\u6DF1\u8272" }[m], m === theme ? "\u2713" : "", () => {
          theme = m;
          showTheme(m);
          renderRoute();
        }))), note("\u4EC5\u6539\u53D8\u5F53\u524D\u754C\u9762\uFF0C\u4E0D\u5F71\u54CD\u5F55\u50CF\u4E0E\u5BA2\u6237\u7AEF\u4E3B\u9898\u3002"), themePreview());
        if (route === "about") menu.append(group(row("AiRec", "\u5B89\u5353\u5F55\u50CF\u4E3B\u673A"), row("\u7248\u672C", "1.0.3"), row("\u9002\u914D\u7CFB\u7EDF", "Android 9 \u53CA\u4EE5\u4E0A"), row("\u8FD0\u884C\u5E73\u53F0", "ARM64 \xB7 RK3399PRO"), row("\u7B2C\u4E09\u65B9\u7EC4\u4EF6\u4E0E\u8BB8\u53EF", "", () => go("licenses"))));
        if (route === "licenses") {
          menu.append(group(row("AiRec", "\u5B89\u5353\u5F55\u50CF\u4E3B\u673A"), row("\u7248\u672C", "1.0.3"), row("\u7CFB\u7EDF\u8981\u6C42", "Android 9 / ARM64")));
          const licenses = group();
          ["Project-GPL-3.0.txt", "YOLOv5-GPL-3.0.txt", "ByteTrack-MIT.txt", "RK3399Pro_npu-Apache-2.0.txt", "Android-NDK-NOTICE.txt"].forEach((name) => licenses.append(row(name, "\u67E5\u770B\u8BB8\u53EF", async () => {
            try {
              const response = await fetch("/static/licenses/" + name);
              if (!response.ok) throw Error("\u8BFB\u53D6\u8BB8\u53EF\u5931\u8D25");
              const text = await response.text();
              $("#media-title").textContent = name;
              $("#media-content").replaceChildren(el("pre", "license-text", text));
              $("#media-note").textContent = "";
              $("#media-dialog").showModal();
            } catch (e) {
              toast(e.message);
            }
          })));
          menu.append(licenses);
        }
        if (route === "service") renderService();
      }
    }
    function themePreview() {
      const box = el("div", "theme-previews");
      ["\u6D45\u8272", "\u6DF1\u8272"].forEach((t) => {
        const p = el("div", "", t);
        p.append(el("i"), el("i"));
        box.append(p);
      });
      return box;
    }
    function renderModel() {
      const m = state.model || {};
      menu.className = "settings-menu two-columns";
      menu.append(
        group(row("\u76EE\u6807\u68C0\u6D4B\u6A21\u578B", m.name || "\u2014"), row("\u76EE\u6807\u8DDF\u8E2A", m.tracker || "\u2014"), row("\u63A8\u7406\u540E\u7AEF", m.backend || "\u2014"), row("\u6A21\u578B\u72B6\u6001", m.ready ? "\u5C31\u7EEA" : m.error || "\u672A\u5C31\u7EEA")),
        group(row("RKNN \u8FD0\u884C\u5E93", (m.sdk_version || "\u2014").split(" (")[0]), row("NPU", m.npu && m.npu.used ? "\u6B63\u5728\u63A8\u7406" : "\u672A\u8FD0\u884C"), row("\u5F55\u50CF\u7F16\u7801", m.vpu && m.vpu.backend || "\u2014"), note(m.vpu && m.vpu.note || "\u5B9E\u9645\u8FD0\u884C\u72B6\u6001\u7531\u8BBE\u5907\u8FD4\u56DE\u3002"))
      );
      menu.append(button("\u5237\u65B0\u4FE1\u606F", () => $("#refresh-model-info").click()));
    }
    function renderLogs() {
      const list = group();
      (state.logs && state.logs.items || []).forEach((item2) => list.append(row(item2.name, bytesText(item2.size_bytes), () => {
        selectedLog = item2;
        go("logDetail");
      }, "\u66F4\u65B0\u4E8E " + dateText(item2.modified_at))));
      menu.append(list, note("\u8BCA\u65AD\u5305\u5305\u542B\u5E94\u7528\u65E5\u5FD7\u3001\u8BBE\u5907\u72B6\u6001\u548C\u6A21\u578B\u4FE1\u606F\uFF0C\u4E0D\u5305\u542B\u5F55\u50CF\u548C\u4E8B\u4EF6\u622A\u56FE\u3002"), button("\u5237\u65B0\u5217\u8868", () => $("#refresh-logs").click()), downloadLink("/api/logs/download", "\u5BFC\u51FA\u8BCA\u65AD\u5305"));
    }
    core.onDiagnostics = () => {
      if (state.page === "settings" && ["model", "logs"].includes(route)) renderRoute();
    };
    function renderDevice() {
      const s = state.connected ? state.status : null, sys = s && s.system || {}, mem = sys.memory || {}, storage = s && s.storage || {};
      systemClone.className = "two-columns";
      systemClone.append(
        group(row("\u8BBE\u5907", sys.hostname || "\u2014"), row("\u5C40\u57DF\u7F51\u5730\u5740", window.HostControl ? HostControl.address() : location.host), row("\u82AF\u7247\u6E29\u5EA6", sys.temperature_c == null ? "\u2014" : sys.temperature_c + " \xB0C"), row("CPU \u4F7F\u7528\u7387", sys.cpu_percent == null ? "\u2014" : sys.cpu_percent + " %")),
        group(row("\u5185\u5B58\u4F7F\u7528", bytesText(mem.used_bytes) + " / " + bytesText(mem.total_bytes)), row("\u5B58\u50A8\u53EF\u7528", bytesText(storage.free_bytes)), row("\u7CFB\u7EDF", sys.os || "\u2014"), row("\u8FDE\u7EED\u8FD0\u884C", s && Number.isFinite(s.uptime_seconds) ? Math.floor(s.uptime_seconds / 60) + " \u5206\u949F" : "\u2014"))
      );
    }
    function renderService() {
      let running = state.connected;
      if (window.HostControl) running = HostControl.running();
      menu.append(
        group(row("\u5F55\u50CF\u670D\u52A1", running ? "\u8FD0\u884C\u4E2D" : "\u5DF2\u505C\u6B62"), row("\u5C40\u57DF\u7F51\u670D\u52A1", running ? "\u7AEF\u53E3 8080" : "\u672A\u542F\u52A8"), row("\u5F00\u673A\u6062\u590D", window.HostControl ? HostControl.enabled() ? "\u5DF2\u542F\u7528" : "\u5DF2\u53D6\u6D88" : "\u8BF7\u5728\u4E3B\u673A\u67E5\u770B")),
        note("\u505C\u6B62\u5F55\u50CF\u4F1A\u5B8C\u6210\u5F53\u524D\u7247\u6BB5\u5199\u5165\uFF0C\u518D\u505C\u6B62\u91C7\u96C6\u3001\u8BC6\u522B\u4E0E\u5C40\u57DF\u7F51\u8BBF\u95EE\uFF0C\u5E76\u53D6\u6D88\u5F00\u673A\u6062\u590D\u3002")
      );
      if (window.HostControl) menu.append(button(running ? "\u505C\u6B62\u5F55\u50CF\u2026" : "\u542F\u52A8\u5F55\u50CF", () => running ? confirmStop() : HostControl.start(), running ? "secondary" : "primary"));
    }
    function backPage() {
      const dialog = $("dialog[open]");
      if (dialog) {
        dialog.close();
        return true;
      }
      if ($(".detail-fullscreen")) {
        $(".detail-fullscreen").classList.remove("detail-fullscreen");
        return true;
      }
      if (state.page === "settings" && route !== "home") {
        go(parents[route] || "home");
        return true;
      }
      if (detail) {
        closeDetail();
        core.setPage("live");
        return true;
      }
      if (state.page !== "live") {
        core.setPage("live");
        return true;
      }
      return false;
    }
    window.AiRecUI = { back: backPage, exportState, nativeState: () => {
      if (state.page === "settings" && route === "service") renderRoute();
      updateStatus();
    } };
    core.onPage = () => {
      if ($("#media-dialog").open) $("#media-dialog").close();
      if (detail) closeDetail();
      if (state.page === "settings") renderRoute();
      updateStatus();
    };
    core.onConfig = configureCards;
    core.onStatus = () => {
      updateStatus();
      if (state.page === "settings" && ["device", "service"].includes(route)) renderRoute();
    };
    function updateStatus() {
      const channels = state.status && state.status.channels || [];
      const count = state.connected ? channels.filter((c) => c.state === "online").length : 0;
      subtitle.textContent = state.connected ? count + " / 5 \u8DEF\u5728\u7EBF \xB7 \u5F55\u50CF\u670D\u52A1\u8FD0\u884C\u4E2D" : "\u6B63\u5728\u8FDE\u63A5\u5F55\u50CF\u673A";
      const stopped = window.HostControl && !HostControl.running();
      serviceState.hidden = !stopped;
      heading.hidden = stopped;
      $("#camera-grid").hidden = stopped;
      system.hidden = stopped;
      statusFoot.hidden = stopped;
      if (stopped) {
        const starting = HostControl.enabled();
        serviceState.replaceChildren(el("h2", "", starting ? "\u6B63\u5728\u542F\u52A8\u5F55\u50CF\u673A" : "\u5F55\u50CF\u670D\u52A1\u5DF2\u505C\u6B62"), note(starting ? "\u6B63\u5728\u68C0\u67E5\u6444\u50CF\u5934\u8BBF\u95EE\u6743\u9650\u3001\u5B58\u50A8\u4ECB\u8D28\u548C\u8BC6\u522B\u6A21\u578B\u2026" : "\u5DF2\u6709\u5F55\u50CF\u4E0E\u914D\u7F6E\u4FDD\u7559\u3002\u542F\u52A8\u540E\u6062\u590D\u9884\u89C8\u548C\u5C40\u57DF\u7F51\u8BBF\u95EE\u3002"));
        if (!starting) serviceState.append(button("\u542F\u52A8\u5F55\u50CF", () => HostControl.start(), "primary"));
      }
      state.cards.forEach((card) => card.node.classList.toggle("online", card.online));
      if (detail && !archive) refreshPreview();
      if (detail && $("#detail-summary")) {
        const c = channels.find((c2) => c2.id === channel), online = state.connected && c && c.state === "online";
        $("#detail-summary").textContent = online ? "\u9884\u89C8 " + Number(c.preview_fps || c.fps || 0).toFixed(1) + " fps \xB7 \u5F55\u50CF " + Number(c.recording_fps || 0).toFixed(1) + " fps" : "\u6682\u65E0\u4FE1\u53F7";
        $("#detail-state .option-value").textContent = online ? c.recording ? "\u5728\u7EBF \xB7 \u8FDE\u7EED\u5F55\u50CF" : "\u5728\u7EBF \xB7 \u672A\u5F55\u50CF" : state.connected ? "\u6682\u65E0\u4FE1\u53F7" : "\u8FDE\u63A5\u4E2D\u65AD";
        $("#detail-mode .option-value").textContent = archive ? "\u5F55\u50CF\u56DE\u653E" : "\u5B9E\u65F6\u753B\u9762";
      }
    }
    const detailPage = el("section", "page channel-detail");
    detailPage.id = "host-channel";
    detailPage.hidden = true;
    $("main").append(detailPage);
    let preview, video, previewMessage, dateInput, track, scroll, position, eventsPanel, tab = "recordings", timelineError;
    function closeDetail() {
      detail = false;
      state.detailChannel = 0;
      sequence++;
      eventSequence++;
      clearTimeout(scrollTimer);
      detailPage.hidden = true;
      if (preview) preview.removeAttribute("src");
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    }
    function refreshPreview() {
      const c = (state.status && state.status.channels || []).find((c2) => c2.id === channel), online = state.connected && c && c.state === "online" && !document.hidden;
      preview.hidden = !online;
      previewMessage.hidden = online;
      previewMessage.textContent = state.connected ? c && c.error || "\u6682\u65E0\u4FE1\u53F7" : "\u6B63\u5728\u91CD\u65B0\u8FDE\u63A5";
      if (online && nativePreview) preview.dataset.nativeChannel = channel;
      else if (online && !preview.getAttribute("src")) preview.src = "/stream/" + channel + ".mjpg";
      if (!online) preview.removeAttribute("src");
    }
    function openChannel(id) {
      closeDetail();
      channel = id;
      core.setPage("live");
      detail = true;
      archive = false;
      state.detailChannel = id;
      for (const card of state.cards.values()) core.stopStream(card);
      $("#page-live").hidden = true;
      detailPage.hidden = false;
      detailPage.replaceChildren();
      const head = el("div", "workspace-head");
      head.append(button("\u2039", () => {
        closeDetail();
        state.detailChannel = 0;
        core.setPage("live");
      }), el("h2", "", "AHD" + id), button("\u901A\u9053\u8BBE\u7F6E", () => {
        closeDetail();
        state.detailChannel = 0;
        go("channel");
      }));
      const layout = el("div", "channel-layout"), left = el("div", "detail-left"), screen = el("div", "detail-screen");
      preview = el("img");
      preview.alt = "AHD" + id + "\u5B9E\u65F6\u753B\u9762";
      video = el("video");
      video.controls = true;
      video.playsInline = true;
      video.hidden = true;
      previewMessage = el("span", "preview-message");
      screen.append(preview, video, previewMessage);
      const controls = el("div", "video-tools");
      controls.append(button("\u8FD4\u56DE\u5B9E\u65F6", () => {
        archive = false;
        currentClip = null;
        video.pause();
        video.removeAttribute("src");
        video.load();
        video.hidden = true;
        refreshPreview();
      }), button("\u5168\u5C4F", () => {
        screen.classList.toggle("detail-fullscreen");
      }), button("\u9000\u51FA\u5168\u5C4F", () => screen.classList.remove("detail-fullscreen")));
      screen.append(controls);
      left.append(screen);
      const summary = el("div", "video-summary");
      summary.id = "detail-summary";
      const statusRow = row("\u5F53\u524D\u72B6\u6001", "\u2014"), modeRow = row("\u5F53\u524D\u6A21\u5F0F", "\u5B9E\u65F6\u753B\u9762");
      statusRow.id = "detail-state";
      modeRow.id = "detail-mode";
      left.append(summary, group(statusRow, modeRow));
      const right = el("section", "timeline-panel"), tabs = el("div", "tabs");
      const timelinePanel = el("div", "day-panel");
      eventsPanel = el("div", "detail-events");
      eventsPanel.hidden = true;
      const playbackTab = button("\u56DE\u653E", () => setTab("recordings")), eventTab = button("\u4E8B\u4EF6", () => setTab("events"));
      function setTab(value) {
        tab = value;
        eventsPanel.hidden = value !== "events";
        timelinePanel.hidden = value !== "recordings";
        playbackTab.classList.toggle("selected", value === "recordings");
        eventTab.classList.toggle("selected", value === "events");
        if (value === "events") loadChannelEvents();
      }
      tabs.append(playbackTab, eventTab);
      setTab("recordings");
      dateInput = el("input");
      dateInput.type = "date";
      dateInput.value = localDate();
      dateInput.max = localDate();
      dateInput.onchange = () => loadDay();
      const dateRow = el("div", "date-row");
      dateRow.append(button("\u2039", () => changeDay(-1)), dateInput, button("\u203A", () => changeDay(1)));
      const zoom = el("div", "zoom-row");
      zoom.append(button("\u5168\u5929", () => {
        precise = false;
        drawTimeline();
      }), button("\u7CBE\u7EC6", () => {
        precise = true;
        drawTimeline();
      }));
      position = el("div", "timeline-position");
      timelineError = el("p", "footnote");
      const legend = el("div", "timeline-legend");
      ["dwell", "person", "vehicle", "animal"].forEach((type, i) => {
        const t = el("span", "event-" + type, ["\u505C\u7559", "\u4EBA", "\u8F66", "\u52A8\u7269"][i]);
        t.prepend(el("i", "event-dot"));
        legend.append(t);
      });
      const viewport = el("div", "timeline-viewport");
      scroll = el("div", "timeline-scroll");
      track = el("div", "timeline-track");
      scroll.append(track);
      viewport.append(scroll, el("div", "time-cursor"));
      scroll.onpointerdown = () => {
        if (video) video.pause();
      };
      scroll.onscroll = () => {
        clearTimeout(scrollTimer);
        if (!day) return;
        selectedTime = day.start + scroll.scrollTop / Number(track.dataset.height) * (day.end - day.start);
        position.textContent = new Date(selectedTime).toLocaleTimeString("zh-CN", { hour12: false });
        scrollTimer = setTimeout(() => seek(selectedTime), 350);
      };
      timelinePanel.append(dateRow, zoom, legend, position, timelineError, viewport, note("\u4E0A\u4E0B\u6ED1\u52A8\u9009\u62E9\u65F6\u95F4\uFF1B\u84DD\u8272\u4E3A\u5F55\u50CF\uFF0C\u7A7A\u767D\u4E3A\u65E0\u5F55\u50CF\u3002"));
      right.append(tabs, timelinePanel, eventsPanel);
      layout.append(left, right);
      detailPage.append(head, layout);
      refreshPreview();
      loadDay();
      preview.onerror = () => {
        preview.removeAttribute("src");
        preview.hidden = true;
        previewMessage.hidden = false;
        previewMessage.textContent = "\u9884\u89C8\u4E2D\u65AD\uFF0C\u6B63\u5728\u91CD\u8FDE";
      };
      video.onerror = () => {
        previewMessage.hidden = false;
        previewMessage.textContent = "\u5F55\u50CF\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u9009\u65F6\u95F4\u6216\u8FD4\u56DE\u5B9E\u65F6";
      };
      video.ontimeupdate = () => {
        if (currentClip && day && currentClip.start + video.currentTime * 1e3 >= Math.min(day.end, currentClip.end) - 100) {
          video.pause();
          const next = index.recordings.find((r) => r.start >= currentClip.end - 150 && r.start <= currentClip.end + 150 && r.id !== currentClip.id);
          if (next && next.start < day.end) seek(next.start);
        }
      };
      video.onended = () => {
        const next = currentClip && index.recordings.find((r) => r.start >= currentClip.end - 150 && r.start <= currentClip.end + 150 && r.id !== currentClip.id);
        if (next && next.start < day.end) seek(next.start);
      };
    }
    function localDate(d = /* @__PURE__ */ new Date()) {
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }
    function changeDay(delta) {
      const d = new Date(dayWindow(dateInput.value).start);
      d.setDate(d.getDate() + delta);
      if (localDate(d) > localDate()) return;
      dateInput.value = localDate(d);
      loadDay();
    }
    async function loadDay() {
      archive = false;
      currentClip = null;
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
        video.hidden = true;
      }
      refreshPreview();
      const token = ++sequence;
      clearTimeout(scrollTimer);
      index = { recordings: [], events: [] };
      track.replaceChildren();
      scroll.style.pointerEvents = "none";
      try {
        day = dayWindow(dateInput.value);
        selectedTime = Math.min(Date.now(), day.end - 1);
        timelineError.textContent = "\u6B63\u5728\u8BFB\u53D6\u5168\u5929\u5F55\u50CF\u2026";
        const data = await api("/api/timeline?channel_id=" + channel + "&start=" + encodeURIComponent(new Date(day.start).toISOString()) + "&end=" + encodeURIComponent(new Date(day.end).toISOString()));
        if (token !== sequence || !detail) return;
        index = decodeIndex(data, channel, day, mediaUrl);
        timelineError.textContent = "";
        scroll.style.pointerEvents = "auto";
        drawTimeline();
      } catch (e) {
        if (token === sequence) {
          timelineError.replaceChildren(el("span", "", e.message), button("\u91CD\u8BD5", loadDay));
        }
      }
    }
    function drawTimeline() {
      clearTimeout(scrollTimer);
      const height = precise ? 8640 : 1440;
      track.dataset.height = height;
      const half = scroll.clientHeight / 2;
      track.style.height = height + half * 2 + "px";
      track.replaceChildren();
      const y = (t) => half + (t - day.start) / (day.end - day.start) * height;
      for (let t = day.start; t <= day.end; t += 36e5) {
        const tick = el("div", "timeline-tick", t === day.end ? "24:00" : new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }));
        tick.style.top = y(t) + "px";
        track.append(tick);
      }
      index.recordings.forEach((r) => {
        const b = el("div", "timeline-recording");
        b.style.top = y(Math.max(day.start, r.start)) + "px";
        b.style.height = Math.max(2, y(Math.min(day.end, r.end)) - y(Math.max(day.start, r.start))) + "px";
        track.append(b);
      });
      index.events.forEach((r) => {
        if (r.end <= day.start || r.start >= day.end) return;
        const b = el("div", "timeline-event event-" + r.type);
        b.style.top = y(Math.max(day.start, r.start)) + "px";
        b.style.height = Math.max(3, y(Math.min(day.end, r.end)) - y(Math.max(day.start, r.start))) + "px";
        track.append(b);
      });
      const handler = scroll.onscroll;
      scroll.onscroll = null;
      scroll.scrollTop = (selectedTime - day.start) / (day.end - day.start) * height;
      position.textContent = new Date(selectedTime).toLocaleTimeString("zh-CN", { hour12: false });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (detail) scroll.onscroll = handler;
      }));
    }
    function seek(time) {
      if (!detail || !day || !Number.isFinite(time)) return;
      time = Math.max(day.start, Math.min(day.end - 1, time));
      archive = true;
      preview.removeAttribute("src");
      preview.hidden = true;
      const clip = atTime(index.recordings, time);
      currentClip = clip;
      video.pause();
      if (!clip) {
        video.hidden = true;
        video.removeAttribute("src");
        video.load();
        previewMessage.hidden = false;
        previewMessage.textContent = "\u6240\u9009\u65F6\u95F4\u6CA1\u6709\u53EF\u7528\u5F55\u50CF";
        return;
      }
      video.hidden = false;
      previewMessage.hidden = true;
      const offset = (time - clip.start) / 1e3;
      const play = () => {
        video.currentTime = offset;
        video.play().catch(() => {
        });
      };
      if (video.getAttribute("src") === clip.url && video.readyState >= 1) play();
      else {
        video.onloadedmetadata = play;
        video.src = clip.url;
        video.load();
      }
    }
    async function loadChannelEvents(type = "") {
      const token = ++eventSequence;
      eventsPanel.replaceChildren();
      const filters = el("div", "chips");
      ["", "dwell", "person", "vehicle", "animal"].forEach((t, i) => filters.append(button(["\u5168\u90E8", "\u505C\u7559", "\u4EBA", "\u8F66", "\u52A8\u7269"][i], () => loadChannelEvents(t))));
      eventsPanel.append(filters);
      try {
        const data = await api("/api/events?channel_id=" + channel + (type ? "&event_type=" + type : ""));
        if (!detail || token !== eventSequence) return;
        (data.items || []).forEach((item2) => {
          const entry = button("", () => openEvent(item2), "channel-event");
          const thumb = el("img");
          const src = mediaUrl(item2.snapshot_url);
          if (src) thumb.src = src;
          thumb.alt = "\u4E8B\u4EF6\u622A\u56FE";
          const text = el("span");
          const label = el("span", "event-label");
          label.append(el("i", "event-dot " + item2.event_type), el("span", "", { person: "\u4EBA", vehicle: "\u8F66", animal: "\u52A8\u7269", dwell: "\u957F\u65F6\u95F4\u505C\u7559" }[item2.event_type] || "\u4E8B\u4EF6"));
          text.append(label, el("small", "", dateText(item2.created_at)));
          entry.append(thumb, text, el("span", "chevron", "\u203A"));
          eventsPanel.append(entry);
        });
        if (!data.items.length) eventsPanel.append(note("\u6682\u65E0\u5339\u914D\u4E8B\u4EF6"));
      } catch (e) {
        if (token === eventSequence) eventsPanel.append(note(e.message));
      }
    }
    function openEvent(item2) {
      $("#media-title").textContent = "\u4E8B\u4EF6\u8BE6\u60C5";
      const content = $("#media-content");
      content.className = "event-detail-content";
      content.replaceChildren();
      const image = el("img");
      const url = mediaUrl(item2.snapshot_url);
      if (url) image.src = url;
      image.alt = "\u4E8B\u4EF6\u622A\u56FE";
      const info = group(row("\u4E8B\u4EF6\u7C7B\u578B", { person: "\u4EBA", vehicle: "\u8F66", animal: "\u52A8\u7269", dwell: "\u957F\u65F6\u95F4\u505C\u7559" }[item2.event_type] || "\u4E8B\u4EF6"), row("\u901A\u9053", "AHD" + item2.channel_id), row("\u53D1\u751F\u65F6\u95F4", dateText(item2.created_at)));
      if (item2.event_type === "dwell") info.append(row("\u505C\u7559\u65F6\u957F", item2.dwell_seconds + " \u79D2"));
      const actions = el("div", "dialog-actions");
      actions.append(downloadLink(item2.snapshot_url, "\u5BFC\u51FA\u622A\u56FE"));
      if (item2.recording_available && mediaUrl(item2.recording_url)) actions.append(button("\u67E5\u770B\u5173\u8054\u5F55\u50CF", () => core.openMedia("video", item2.recording_url, "\u5173\u8054\u5F55\u50CF")));
      content.append(image, info, actions);
      $("#media-note").textContent = "";
      if (!$("#media-dialog").open) $("#media-dialog").show();
    }
    core.openEvent = openEvent;
    state.cards.forEach((card) => {
      card.screen.tabIndex = 0;
      card.screen.setAttribute("role", "button");
      card.screen.setAttribute("aria-label", "\u6253\u5F00 AHD" + card.id + " \u8BE6\u60C5");
      card.screen.onclick = () => openChannel(card.id);
      card.screen.onkeydown = (e) => {
        if (e.key === "Enter") openChannel(card.id);
      };
    });
    document.addEventListener("visibilitychange", () => {
      if (detail) {
        if (document.hidden) {
          preview.removeAttribute("src");
          video.pause();
        } else if (!archive) refreshPreview();
      }
    });
    core.onInvalid = (input) => {
      const card = input.closest("[data-channel-id]");
      if (card) {
        channel = Number(card.dataset.channelId);
        go(input.closest("[data-panel]").dataset.panel);
      } else go("storage");
      input.reportValidity();
    };
    core.onPage();
  }

  // web-src/app.js
  (() => {
    const ui = {};
    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
    const pageNames = { live: "\u5B9E\u65F6\u753B\u9762", recordings: "\u5F55\u50CF\u56DE\u653E", events: "\u667A\u80FD\u4E8B\u4EF6", settings: "\u8BBE\u5907\u8BBE\u7F6E" };
    const categoryNames = { person: "\u4EBA", vehicle: "\u8F66", animal: "\u52A8\u7269" };
    const eventNames = { dwell: "\u957F\u65F6\u95F4\u505C\u7559", person: "\u4EBA", vehicle: "\u8F66", animal: "\u52A8\u7269" };
    const cropChoices = [["\u5B8C\u6574\u753B\u9762", [0, 0, 1, 1]], ["\u5DE6\u4E0A\u533A\u57DF", [0, 0, 0.5, 0.5]], ["\u53F3\u4E0A\u533A\u57DF", [0.5, 0, 0.5, 0.5]], ["\u5DE6\u4E0B\u533A\u57DF", [0, 0.5, 0.5, 0.5]], ["\u53F3\u4E0B\u533A\u57DF", [0.5, 0.5, 0.5, 0.5]]];
    const liveStates = /* @__PURE__ */ new Set(["online", "running", "streaming", "connected", "live", "ok"]);
    const stateNames = { online: "\u5728\u7EBF", running: "\u5728\u7EBF", streaming: "\u5728\u7EBF", connected: "\u5728\u7EBF", live: "\u5728\u7EBF", ok: "\u5728\u7EBF", disabled: "\u5DF2\u505C\u7528", offline: "\u65E0\u4FE1\u53F7", no_signal: "\u65E0\u4FE1\u53F7", waiting: "\u7B49\u5F85\u4FE1\u53F7", connecting: "\u8FDE\u63A5\u4E2D", reconnecting: "\u91CD\u65B0\u8FDE\u63A5", error: "\u8FDE\u63A5\u5F02\u5E38", stopped: "\u5DF2\u505C\u6B62", starting: "\u542F\u52A8\u4E2D" };
    const state = { page: "live", config: null, status: null, dirty: false, saving: false, connected: false, timer: null, pollBusy: false, toastTimer: null, cards: /* @__PURE__ */ new Map(), requests: { recordings: 0, events: 0 }, nextListRefresh: 0, nextDiagnosticsRefresh: 0, storageTargets: null, storageTargetError: "", copySourceId: null };
    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== void 0) node.textContent = String(text);
      return node;
    }
    async function api(path, options = {}) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15e3);
      try {
        const response = await fetch(path, { ...options, signal: controller.signal, cache: "no-store", headers: { "Accept": "application/json", ...options.body ? { "Content-Type": "application/json" } : {}, ...options.headers } });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || (response.status === 404 ? "\u63A5\u53E3\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u68C0\u67E5\u670D\u52A1\u7248\u672C\u3002" : `\u8BF7\u6C42\u5931\u8D25\uFF08${response.status}\uFF09`));
        return data;
      } catch (error) {
        if (error.name === "AbortError") throw new Error("\u8BBE\u5907\u54CD\u5E94\u8D85\u65F6\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
        if (error instanceof TypeError) throw new Error("\u65E0\u6CD5\u8FDE\u63A5\u5F00\u53D1\u677F\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u4E0E\u670D\u52A1\u3002");
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
      state.toastTimer = setTimeout(() => {
        target.hidden = true;
      }, 4500);
    }
    function dateText(value) {
      if (!value) return "\u2014";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
    }
    function bytesText(value) {
      if (value === null || value === void 0 || value === "") return "\u2014";
      const bytes = Number(value);
      if (!Number.isFinite(bytes) || bytes < 0) return "\u2014";
      if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
      if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
      return `${Math.round(bytes / 1024)} KB`;
    }
    function durationText(value) {
      const seconds = Math.round(Number(value));
      if (!Number.isFinite(seconds) || seconds < 0) return "\u2014";
      return seconds >= 60 ? `${Math.floor(seconds / 60)} \u5206 ${seconds % 60} \u79D2` : `${seconds} \u79D2`;
    }
    function metricNumber(value) {
      return value === null || value === void 0 || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
    }
    function uptimeText(value) {
      const seconds = metricNumber(value);
      if (seconds === null || seconds < 0) return "\u8FD0\u884C\u65F6\u95F4\u6682\u4E0D\u53EF\u7528";
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor(seconds / 3600) % 24;
      const minutes = Math.floor(seconds / 60) % 60;
      return `\u670D\u52A1\u5DF2\u8FD0\u884C ${days ? `${days} \u5929 ` : ""}${hours ? `${hours} \u5C0F\u65F6 ` : ""}${minutes} \u5206\u949F`;
    }
    function updateSystem(data) {
      var _a, _b, _c;
      const system = data.system || {};
      const storage = data.storage || {};
      const memory = system.memory || {};
      const temperature = metricNumber(system.temperature_c);
      const cpu = metricNumber(system.cpu_percent);
      $("#system-hostname").textContent = system.hostname || "RK3399 PRO";
      $("#system-uptime").textContent = uptimeText(data.uptime_seconds);
      $("#system-temperature").textContent = temperature === null ? "\u2014" : `${temperature.toFixed(1)} \xB0C`;
      $("#system-cpu").textContent = cpu === null ? "\u2014" : `${cpu.toFixed(1)} %`;
      $("#system-cpu-meter").value = Math.max(0, Math.min(100, cpu || 0));
      $("#system-cpu-meter").hidden = cpu === null;
      $("#system-memory").textContent = `${bytesText(memory.used_bytes)} / ${bytesText(memory.total_bytes)}`;
      const memoryPercent = metricNumber(memory.used_percent);
      $("#system-memory-meter").value = Math.max(0, Math.min(100, memoryPercent || 0));
      $("#system-memory-meter").hidden = memoryPercent === null;
      $("#system-storage").textContent = `${bytesText(storage.free_bytes)} / ${bytesText(storage.total_bytes)}`;
      const selectedId = storage.target_id || ((_b = (_a = state.config) == null ? void 0 : _a.storage) == null ? void 0 : _b.target_id) || "internal";
      const target = (_c = state.storageTargets) == null ? void 0 : _c.find((item2) => item2.id === selectedId);
      $("#system-storage-label").textContent = storage.recording_allowed === false ? "\u7A7A\u95F4\u6216\u4ECB\u8D28\u4E0D\u53EF\u7528 \xB7 \u5F55\u50CF\u5DF2\u6682\u505C" : (target == null ? void 0 : target.label) || (selectedId === "internal" ? "\u5F53\u524D\u4F7F\u7528\u5185\u7F6E\u5B58\u50A8" : "\u5F53\u524D\u4F7F\u7528\u5916\u90E8\u5B58\u50A8");
      $("#system-storage-label").title = storage.error || (target == null ? void 0 : target.mountpoint) || "";
      $("#system-health").textContent = storage.recording_allowed === false ? "\u5F55\u50CF\u6682\u505C" : "\u8BBE\u5907\u8FD0\u884C\u4E2D";
      $("#system-health").className = `badge ${storage.recording_allowed === false ? "error" : "live"}`;
    }
    function channelName(id) {
      var _a, _b, _c;
      return ((_c = (_b = (_a = state.config) == null ? void 0 : _a.channels) == null ? void 0 : _b.find((channel) => String(channel.id) === String(id))) == null ? void 0 : _c.name) || `AHD ${id}`;
    }
    function mediaUrl(value) {
      if (typeof value !== "string" || !value) return null;
      try {
        const url = new URL(value, location.origin);
        return url.origin === location.origin && ["http:", "https:"].includes(url.protocol) ? url.href : null;
      } catch (_) {
        return null;
      }
    }
    function isOnline(channel) {
      return channel.enabled !== false && liveStates.has(channel.state);
    }
    function positionBoxes(card) {
      const { naturalWidth, naturalHeight } = card.img;
      if (!naturalWidth || !naturalHeight || card.img.hidden || !card.online) {
        card.boxes.hidden = true;
        return;
      }
      const width = card.screen.clientWidth;
      const height = card.screen.clientHeight;
      const scale = Math.min(width / naturalWidth, height / naturalHeight);
      const imageWidth = naturalWidth * scale;
      const imageHeight = naturalHeight * scale;
      Object.assign(card.boxes.style, { left: `${(width - imageWidth) / 2}px`, top: `${(height - imageHeight) / 2}px`, width: `${imageWidth}px`, height: `${imageHeight}px` });
      card.boxes.hidden = !card.boxes.childElementCount;
    }
    function updateBoxes(card, detections) {
      const fragment = document.createDocumentFragment();
      for (const detection of detections.slice(0, 20)) {
        if (!Array.isArray(detection.bbox) || detection.bbox.length !== 4 || !detection.bbox.every(Number.isFinite)) continue;
        const [x1, y1, x2, y2] = detection.bbox.map((value) => Math.min(1, Math.max(0, value)));
        if (x2 <= x1 || y2 <= y1) continue;
        const category = Object.prototype.hasOwnProperty.call(categoryNames, detection.category) ? detection.category : "person";
        const dwellEligible = detection.category === "person" && detection.dwell_eligible !== false;
        const dwellReached = dwellEligible && detection.dwell_reached === true;
        const box = el("div", `detection-box detection-${dwellReached ? "dwell" : category}`);
        Object.assign(box.style, { left: `${x1 * 100}%`, top: `${y1 * 100}%`, width: `${(x2 - x1) * 100}%`, height: `${(y2 - y1) * 100}%` });
        const dwell = metricNumber(detection.dwell_seconds);
        let label = categoryNames[detection.category] || "\u76EE\u6807";
        if (dwellEligible) label += ` \xB7 ${dwellReached ? "\u957F\u65F6\u95F4\u505C\u7559 " : ""}${dwell !== null && dwell >= 0 ? `${dwell.toFixed(1)} \u79D2` : "\u8BA1\u65F6\u4E2D"}`;
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
        const card = { id, node, img: $(".camera-image", node), screen: $(".camera-screen", node), boxes: $(".camera-boxes", node), placeholder: $(".camera-placeholder", node), detections: [], online: false, streaming: false, retries: 0, retryTimer: null };
        $(".camera-number", node).textContent = String(id).padStart(2, "0");
        $(".camera-name strong", node).textContent = `AHD ${id}`;
        card.img.alt = `AHD ${id} \u5B9E\u65F6\u753B\u9762`;
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
          $("strong", card.placeholder).textContent = "\u9884\u89C8\u8FDE\u63A5\u4E2D\u65AD";
          $("small", card.placeholder).textContent = card.retries <= 3 ? "\u6B63\u5728\u5C1D\u8BD5\u6062\u590D\u9884\u89C8" : "\u8BF7\u70B9\u51FB\u201C\u91CD\u65B0\u8FDE\u63A5\u753B\u9762\u201D\u91CD\u8BD5";
          if (card.retries <= 3) card.retryTimer = setTimeout(() => {
            card.retryTimer = null;
            startStream(card);
          }, card.retries * 2500);
        });
        $(".camera-fullscreen", node).addEventListener("click", () => {
          const expanded = node.classList.contains("camera-expanded");
          for (const other of $$(".camera-expanded")) other.classList.remove("camera-expanded");
          node.classList.toggle("camera-expanded", !expanded);
          positionBoxes(card);
        });
        $(".camera-snapshot", node).addEventListener("click", async () => {
          if (!card.online) return toast("\u5F53\u524D\u901A\u9053\u6682\u65E0\u753B\u9762\u3002");
          if (location.hostname === "127.0.0.1") {
            const link = el("a");
            link.href = `/api/snapshot/${id}.jpg?download=1`;
            link.click();
            return;
          }
          try {
            const response = await fetch(`/api/snapshot/${id}.jpg`, { cache: "no-store", signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(1e4) : void 0 });
            if (!response.ok) throw new Error("\u622A\u56FE\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
            const url = URL.createObjectURL(await response.blob());
            const link = el("a");
            link.href = url;
            link.download = `AHD${id}_${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.jpg`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1e4);
          } catch (error) {
            toast(error.message || "\u622A\u56FE\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u8FDE\u63A5\u3002");
          }
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
      var _a, _b, _c, _d, _e, _f;
      const channels = Array.isArray(data.channels) ? data.channels : [];
      const online = channels.filter(isOnline).length;
      $("#online-count").textContent = online;
      $("#recording-count").textContent = channels.filter((channel) => {
        var _a2;
        return channel.recording === true || ((_a2 = channel.recording) == null ? void 0 : _a2.active) === true;
      }).length;
      $("#online-hint").textContent = online === 5 ? "\u6240\u6709\u901A\u9053\u5DF2\u8FDE\u63A5" : online ? `${5 - online} \u8DEF\u672A\u63A5\u5165\u6216\u5DF2\u505C\u7528` : "\u7B49\u5F85\u6444\u50CF\u5934\u63A5\u5165";
      const detector = data.detector || {};
      $("#detector-state").textContent = detector.ready ? "\u5DF2\u5C31\u7EEA" : detector.error ? "\u6682\u4E0D\u53EF\u7528" : "\u51C6\u5907\u4E2D";
      $("#detector-backend").textContent = detector.backend || "AI";
      $("#detector-hint").textContent = detector.error || "\u4EBA \xB7 \u8F66 \xB7 \u52A8\u7269";
      $("#detector-hint").title = detector.error || "";
      const storage = data.storage || {};
      $("#free-space").textContent = metricNumber(storage.free_bytes) === null ? "\u2014" : (Number(storage.free_bytes) / 1024 ** 3).toFixed(1);
      $("#storage-hint").textContent = storage.recording_allowed === false ? "\u5F55\u50CF\u5DF2\u6682\u505C \xB7 \u8BF7\u68C0\u67E5\u4ECB\u8D28\u4E0E\u7A7A\u95F4" : storage.total_bytes ? `\u603B\u5BB9\u91CF ${bytesText(storage.total_bytes)}` : "\u6682\u65E0\u6CD5\u8BFB\u53D6\u5B58\u50A8\u7A7A\u95F4";
      updateSystem(data);
      for (const card of state.cards.values()) {
        const channel = channels.find((item2) => String(item2.id) === String(card.id)) || { enabled: true, state: "waiting" };
        const wasOnline = card.online;
        card.online = isOnline(channel);
        if (card.online !== wasOnline) stopStream(card, true);
        $(".camera-name strong", card.node).textContent = channel.name || channelName(card.id);
        card.img.alt = `${channel.name || channelName(card.id)} \u5B9E\u65F6\u753B\u9762`;
        const badge = $(".camera-state", card.node);
        badge.textContent = channel.enabled === false ? "\u5DF2\u505C\u7528" : stateNames[channel.state] || "\u7B49\u5F85\u4FE1\u53F7";
        badge.className = `camera-state badge${card.online ? " live" : channel.error ? " error" : ""}`;
        badge.title = channel.error || "";
        $(".recording-badge", card.node).hidden = !(card.online && (channel.recording === true || ((_a = channel.recording) == null ? void 0 : _a.active) === true));
        const previewFps = metricNumber((_b = channel.preview_fps) != null ? _b : channel.fps);
        const recordingFps = metricNumber(channel.recording_fps);
        const info = $(".camera-info", card.node);
        const config = (_d = (_c = state.config) == null ? void 0 : _c.channels) == null ? void 0 : _d.find((item2) => String(item2.id) === String(card.id));
        info.textContent = card.online ? `\u9884\u89C8 ${previewFps === null ? "\u2014" : previewFps.toFixed(1)} \xB7 \u5F55\u50CF ${recordingFps === null ? "\u2014" : recordingFps.toFixed(1)} fps` : channel.enabled === false ? "\u901A\u9053\u5DF2\u505C\u7528" : "\u7B49\u5F85\u89C6\u9891\u4FE1\u53F7 \xB7 \u81EA\u52A8\u91CD\u8FDE";
        info.title = card.online ? `\u5B9E\u9645\u5E27\u7387\uFF1A\u9884\u89C8 ${previewFps === null ? "\u2014" : previewFps.toFixed(1)} fps\uFF0C\u5F55\u50CF ${recordingFps === null ? "\u2014" : recordingFps.toFixed(1)} fps\u3002\u8BBE\u7F6E\u76EE\u6807\uFF1A\u5F55\u50CF ${(_e = config == null ? void 0 : config.fps) != null ? _e : "\u2014"} fps\uFF0C\u9884\u89C8 ${(_f = config == null ? void 0 : config.preview_fps) != null ? _f : "\u2014"} fps\u3002\u5B9E\u9645\u503C\u968F\u8BBE\u5907\u8D1F\u8F7D\u548C\u7F51\u7EDC\u72B6\u6001\u53D8\u5316\u3002` : channel.error || "";
        if (!card.online || card.retries === 0) {
          $("strong", card.placeholder).textContent = channel.enabled === false ? "\u901A\u9053\u5DF2\u505C\u7528" : card.online ? "\u6B63\u5728\u8FDE\u63A5\u753B\u9762" : "\u6682\u65E0\u4FE1\u53F7";
          $("small", card.placeholder).textContent = channel.enabled === false ? "\u53EF\u5728\u8BBE\u5907\u8BBE\u7F6E\u4E2D\u542F\u7528" : channel.error || (card.online ? "\u8BF7\u7A0D\u5019" : "\u6444\u50CF\u5934\u63A5\u5165\u540E\u81EA\u52A8\u6062\u590D");
        }
        const detections = Array.isArray(channel.detections) ? channel.detections : [];
        card.detections = card.online ? detections.filter((item2) => item2 && typeof item2 === "object") : [];
        updateBoxes(card, card.detections);
        const labels = [...new Set(card.detections.map((item2) => categoryNames[item2.category] || item2.label || "\u76EE\u6807"))];
        const detectionLabel = $(".camera-detections", card.node);
        detectionLabel.hidden = !card.online || !labels.length;
        detectionLabel.textContent = `\u4FA6\u6D4B\u5230\uFF1A${labels.join("\u3001")}`;
      }
      syncStreams();
    }
    function connectionChanged(connected, error = "") {
      state.connected = connected;
      $("#connection-dot").className = `connection-dot ${connected ? "online" : "offline"}`;
      $("#connection-label").textContent = connected ? "\u8BBE\u5907\u5DF2\u8FDE\u63A5" : "\u8BBE\u5907\u8FDE\u63A5\u4E2D\u65AD";
      $("#connection-warning").hidden = connected;
      $("#connection-warning").textContent = `${error} \u9875\u9762\u4F1A\u81EA\u52A8\u91CD\u65B0\u8FDE\u63A5\uFF0C\u5DF2\u4FDD\u5B58\u7684\u8BBE\u7F6E\u4E0D\u53D7\u5F71\u54CD\u3002`;
      $(".system-panel").classList.toggle("stale", !connected);
      if (!connected) {
        $("#system-health").textContent = "\u72B6\u6001\u672A\u66F4\u65B0";
        $("#system-health").className = "badge error";
        $("#online-count").textContent = "\u2014";
        $("#recording-count").textContent = "\u2014";
        $("#online-hint").textContent = "\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u65E0\u6CD5\u786E\u8BA4\u5F53\u524D\u72B6\u6001";
        for (const card of state.cards.values()) {
          stopStream(card, true);
          $("strong", card.placeholder).textContent = "\u8BBE\u5907\u8FDE\u63A5\u4E2D\u65AD";
          $("small", card.placeholder).textContent = "\u7F51\u7EDC\u6062\u590D\u540E\u81EA\u52A8\u91CD\u65B0\u8FDE\u63A5";
          $(".camera-state", card.node).textContent = "\u72B6\u6001\u672A\u77E5";
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
        if (ui.onStatus) ui.onStatus();
        if (!state.config) await loadConfig();
        if (["recordings", "events"].includes(state.page) && Date.now() >= state.nextListRefresh) {
          state.nextListRefresh = Date.now() + 15e3;
          await loadList(state.page, false);
        }
        if (state.page === "settings" && Date.now() >= state.nextDiagnosticsRefresh) loadDiagnostics();
      } catch (error) {
        connectionChanged(false, error.message);
        if (ui.onStatus) ui.onStatus();
      } finally {
        state.pollBusy = false;
        if (!document.hidden) state.timer = setTimeout(poll, 3e3);
      }
    }
    function setPage(name, updateHash = true) {
      if (!(name in pageNames)) name = "live";
      state.page = name;
      $$(".page").forEach((page) => {
        page.hidden = page.id !== `page-${name}`;
      });
      $$(".nav-button").forEach((button) => {
        button.classList.toggle("active", button.dataset.page === name);
        if (button.dataset.page === name) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      });
      $("#page-label").textContent = pageNames[name];
      document.title = `${pageNames[name]} \xB7 \u667A\u80FD\u5F55\u50CF\u673A`;
      window.scrollTo(0, 0);
      if (updateHash) history.replaceState(null, "", `#${name}`);
      syncStreams(true);
      if (["recordings", "events"].includes(name)) {
        state.nextListRefresh = Date.now() + 15e3;
        loadList(name, true);
      }
      if (ui.onPage) ui.onPage();
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
      var _a;
      state.model = data;
      $("#model-name").textContent = data.name || "\u2014";
      $("#model-version").textContent = data.version || "\u2014";
      const commit = typeof data.commit === "string" ? data.commit : "";
      $("#model-commit").textContent = commit ? commit.slice(0, 8) : "\u2014";
      $("#model-commit").title = commit;
      $("#model-backend").textContent = data.backend_label || data.backend || "\u2014";
      $("#model-runtime").textContent = [data.tracker, data.opencv_version ? `OpenCV ${data.opencv_version}` : "", data.sdk_version || ""].filter(Boolean).join(" \xB7 ") || "\u8FD0\u884C\u5E93\u7248\u672C\uFF1A\u2014";
      const files = Array.isArray(data.files) ? data.files : [];
      const verified = files.length > 0 && files.every((file) => file.verified === true);
      const failed = files.some((file) => file.verified === false);
      $("#model-weights").textContent = verified ? "\u6821\u9A8C\u901A\u8FC7" : failed ? "\u6821\u9A8C\u672A\u901A\u8FC7" : "\u672A\u6821\u9A8C";
      $("#model-weights").className = `badge${verified ? " live" : failed ? " error" : ""}`;
      $("#model-weights").title = files.map((file) => `${file.name || "\u6A21\u578B\u6587\u4EF6"} \xB7 ${bytesText(file.size_bytes)} \xB7 SHA-256 ${file.sha256 || "\u2014"}`).join("\n");
      for (const key of ["vpu", "npu"]) {
        const accelerator = data[key] || {};
        const enabled = accelerator.used === true ? "\u5DF2\u542F\u7528" : accelerator.used === false ? "\u672A\u542F\u7528" : "\u2014";
        const value = $(`#model-${key}`);
        value.replaceChildren();
        if (accelerator.used === true && accelerator.backend) value.append(el("span", "", `${accelerator.backend} \xB7 `));
        value.append(el("span", "acceleration-state", enabled));
        const channels = Array.isArray(accelerator.channels) && accelerator.channels.length ? `\u901A\u9053 ${accelerator.channels.join("\u3001")}\u3002` : "";
        $(`#model-${key}-note`).textContent = `${channels}${accelerator.note || ""}` || "\u2014";
      }
      const mapping = $("#model-category-mapping");
      mapping.replaceChildren();
      for (const [key, label] of Object.entries(categoryNames)) {
        const labels = (_a = data.category_mapping) == null ? void 0 : _a[key];
        if (!Array.isArray(labels) || !labels.length) continue;
        const row = el("p");
        row.append(el("strong", "", label), el("span", "", labels.join(" / ")));
        mapping.append(row);
      }
      if (!mapping.childElementCount) mapping.textContent = "\u2014";
      const limitations = Array.isArray(data.limitations) ? data.limitations.filter((item2) => typeof item2 === "string") : [];
      $("#model-limitations").textContent = limitations.join(" ") || "\u6A21\u578B\u4E0E\u52A0\u901F\u72B6\u6001\u7531\u8BBE\u5907\u62A5\u544A\uFF1B\u4E0D\u53EF\u7528\u7684\u4FE1\u606F\u663E\u793A\u4E3A\u201C\u2014\u201D\u3002";
      diagnosticFeedback("#model-feedback", data.ready === true ? "" : data.ready === false ? "\u8BC6\u522B\u6A21\u578B\u5C1A\u672A\u5C31\u7EEA\uFF0C\u53EF\u4E0B\u8F7D\u8BCA\u65AD\u65E5\u5FD7\u67E5\u770B\u52A0\u8F7D\u60C5\u51B5\u3002" : "\u6A21\u578B\u8FD0\u884C\u72B6\u6001\u6682\u4E0D\u53EF\u7528\u3002", data.ready === false);
    }
    async function loadModelInfo() {
      const button = $("#refresh-model-info");
      if (button.disabled) return;
      button.disabled = true;
      try {
        renderModelInfo(await api("/api/diagnostics/model"));
      } catch (error) {
        renderModelInfo({});
        diagnosticFeedback("#model-feedback", `\u6A21\u578B\u4FE1\u606F\u8BFB\u53D6\u5931\u8D25\uFF1A${error.message}`, true);
      } finally {
        button.disabled = false;
        if (ui.onDiagnostics) ui.onDiagnostics();
      }
    }
    async function loadLogs() {
      const button = $("#refresh-logs");
      if (button.disabled) return;
      button.disabled = true;
      try {
        const data = await api("/api/logs");
        state.logs = data;
        if (!Array.isArray(data.items)) throw new Error("\u8BBE\u5907\u672A\u8FD4\u56DE\u65E5\u5FD7\u5217\u8868\u3002");
        const fragment = document.createDocumentFragment();
        for (const item2 of data.items) {
          if (!item2 || typeof item2 !== "object") continue;
          const row = el("tr");
          row.append(el("td", "", item2.name || "\u672A\u547D\u540D\u65E5\u5FD7"), el("td", "", bytesText(item2.size_bytes)), el("td", "", dateText(item2.modified_at)));
          fragment.append(row);
        }
        $("#logs-body").replaceChildren(fragment);
        if (ui.onDiagnostics) ui.onDiagnostics();
        $(".logs-table").hidden = !$("#logs-body").childElementCount;
        $("#logs-scope").textContent = data.scope || "\u4E0B\u8F7D\u8BBE\u5907\u65E5\u5FD7\u4E0E\u8FD0\u884C\u4FE1\u606F\uFF0C\u7528\u4E8E\u5206\u6790\u91C7\u96C6\u3001\u5F55\u50CF\u548C\u8BC6\u522B\u95EE\u9898\u3002";
        const limit = metricNumber(data.max_bundle_bytes);
        $("#logs-note").textContent = `${limit !== null && limit > 0 ? `\u5355\u6B21\u65E5\u5FD7\u91C7\u96C6\u4E0A\u9650\u7EA6 ${bytesText(limit)}\u3002` : ""}\u4E0B\u8F7D\u5185\u5BB9\u4E3A\u8BCA\u65AD\u538B\u7F29\u5305\uFF1B\u5237\u65B0\u65E5\u5FD7\u4E0D\u4F1A\u6539\u52A8\u5C1A\u672A\u4FDD\u5B58\u7684\u901A\u9053\u8BBE\u7F6E\u3002`;
        diagnosticFeedback("#logs-feedback", $("#logs-body").childElementCount ? "" : "\u6682\u65E0\u65E5\u5FD7\u6587\u4EF6\uFF0C\u4ECD\u53EF\u4E0B\u8F7D\u5305\u542B\u8FD0\u884C\u72B6\u6001\u7684\u8BCA\u65AD\u5305\u3002");
      } catch (error) {
        diagnosticFeedback("#logs-feedback", `\u65E5\u5FD7\u5217\u8868\u8BFB\u53D6\u5931\u8D25\uFF1A${error.message} \u53EF\u4EE5\u5237\u65B0\u91CD\u8BD5\u3002`, true);
      } finally {
        button.disabled = false;
      }
    }
    function loadDiagnostics() {
      state.nextDiagnosticsRefresh = Date.now() + 15e3;
      return Promise.allSettled([loadModelInfo(), loadLogs()]);
    }
    function openMedia(type, value, title, metadata = {}) {
      const url = mediaUrl(value);
      if (!url) return toast("\u8BE5\u5A92\u4F53\u6587\u4EF6\u6682\u4E0D\u53EF\u7528\u3002");
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
      media.addEventListener("error", () => {
        $("#media-note").textContent = "\u6587\u4EF6\u53EF\u80FD\u5DF2\u88AB\u81EA\u52A8\u6E05\u7406\uFF0C\u6216\u6B64\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u8BE5\u7F16\u7801\u3002\u8BF7\u5237\u65B0\u5217\u8868\u6216\u4E0B\u8F7D\u5F55\u50CF\u3002";
      });
      content.append(media);
      if (type === "video") {
        const details = el("div", "option-group");
        [["\u901A\u9053", metadata.channel_id ? channelName(metadata.channel_id) : title], ["\u5F00\u59CB\u65F6\u95F4", dateText(metadata.created_at)], ["\u7247\u6BB5\u65F6\u957F", durationText(metadata.duration_seconds)], ["\u6587\u4EF6\u5927\u5C0F", bytesText(metadata.size_bytes)]].forEach(([name, value2]) => {
          const r = el("div", "option-row");
          r.append(el("span", "option-label", name), el("span", "option-value", value2));
          details.append(r);
        });
        content.append(details, downloadLink(value, "\u5BFC\u51FA\u5F55\u50CF"));
      }
      $("#media-title").textContent = title;
      $("#media-note").replaceChildren();
      if (type === "video") $("#media-note").append(downloadLink(value, "\u5BFC\u51FA\u5F55\u50CF"));
      const dialog = $("#media-dialog");
      if (!dialog.open) dialog.show();
    }
    function downloadLink(value, text = "\u4E0B\u8F7D") {
      const url = mediaUrl(value);
      if (!url) return el("span", "muted", "\u6587\u4EF6\u4E0D\u53EF\u7528");
      const link = el("a", "download-link", text);
      link.href = location.hostname === "127.0.0.1" ? `${url}${url.includes("?") ? "&" : "?"}download=1` : url;
      if (location.hostname !== "127.0.0.1") link.download = "";
      return link;
    }
    function renderRecordings(items) {
      const body = $("#recordings-body");
      const fragment = document.createDocumentFragment();
      for (const item2 of items) {
        const row = el("tr");
        const file = el("td");
        file.append(el("span", "", "\u25B7  " + channelName(item2.channel_id)));
        if (item2.available === false) file.append(el("small", "", item2.error || "\u5F55\u50CF\u4ECB\u8D28\u5C1A\u672A\u63A5\u5165"));
        row.append(file, el("td", "", dateText(item2.created_at)), el("td", "", durationText(item2.duration_seconds)), el("td", "", bytesText(item2.size_bytes)));
        const actions = el("td");
        const play = el("button", "button secondary small", "\u203A");
        play.disabled = item2.available === false || !mediaUrl(item2.url);
        play.addEventListener("click", () => openMedia("video", item2.url, `${channelName(item2.channel_id)} \xB7 \u5F55\u50CF\u56DE\u653E`, item2));
        actions.append(play);
        row.append(actions);
        fragment.append(row);
      }
      body.replaceChildren(fragment);
      $("#recording-count-label").textContent = `\u663E\u793A ${items.length} \u4E2A\u7247\u6BB5`;
      $(".table-wrap").hidden = !items.length;
    }
    function renderEvents(items) {
      const fragment = document.createDocumentFragment();
      for (const item2 of items) {
        const type = Object.prototype.hasOwnProperty.call(eventNames, item2.event_type) ? item2.event_type : "dwell";
        const card = el("article", "event-card");
        const imageButton = el("button", "event-image-button");
        imageButton.setAttribute("aria-label", "\u67E5\u770B\u4E8B\u4EF6\u622A\u56FE");
        const url = mediaUrl(item2.snapshot_url);
        if (url) {
          const picture = el("img");
          picture.src = url;
          picture.alt = `${channelName(item2.channel_id)} \u4E8B\u4EF6\u622A\u56FE`;
          picture.loading = "lazy";
          picture.addEventListener("error", () => {
            imageButton.replaceChildren(el("span", "", "\u622A\u56FE\u6682\u4E0D\u53EF\u7528"));
          });
          imageButton.append(picture);
          imageButton.addEventListener("click", () => ui.openEvent(item2));
        } else {
          imageButton.textContent = "\u6682\u65E0\u622A\u56FE";
          imageButton.disabled = true;
        }
        const content = el("div", "event-content");
        const title = el("h3");
        const typeLabel = el("span", `event-label event-${type}`);
        const dot = el("span", "event-dot");
        dot.setAttribute("aria-hidden", "true");
        typeLabel.append(dot, el("span", "", eventNames[type]));
        title.append(typeLabel);
        const dwell = metricNumber(item2.dwell_seconds);
        const badge = type === "dwell" ? `${categoryNames[item2.category] || item2.label || "\u76EE\u6807"} \xB7 ${dwell !== null && dwell >= 0 ? `${dwell.toFixed(1)} \u79D2` : "\u5DF2\u8FBE\u9608\u503C"}` : "\u9996\u6B21\u786E\u8BA4";
        title.append(el("span", "event-detail", badge));
        content.append(title, el("p", "", `${channelName(item2.channel_id)} \xB7 \u5F55\u50CF\u56DE\u653E`, item2));
        const actions = el("div", "event-actions");
        actions.append(downloadLink(item2.snapshot_url, "\u4E0B\u8F7D\u622A\u56FE"));
        if (mediaUrl(item2.recording_url)) {
          const play = el("button", "button secondary small", "\u67E5\u770B\u5F55\u50CF");
          play.addEventListener("click", () => openMedia("video", item2.recording_url, `${channelName(item2.channel_id)} \xB7 \u4E8B\u4EF6\u5F55\u50CF`));
          actions.append(play);
        } else actions.append(el("span", "muted", "\u5F55\u50CF\u5B8C\u6210\u540E\u53EF\u5173\u8054"));
        content.append(actions);
        card.append(imageButton, content);
        card.onclick = () => ui.openEvent(item2);
        fragment.append(card);
      }
      $("#events-grid").replaceChildren(fragment);
      $("#event-count-label").textContent = `\u663E\u793A ${items.length} \u6761\u4E8B\u4EF6`;
    }
    async function loadList(kind, showLoading = false) {
      const sequence = ++state.requests[kind];
      const feedback = $(`#${kind}-feedback`);
      const filter = kind === "recordings" ? $("#recording-filter").value : $("#event-filter").value;
      const eventType = kind === "events" ? $("#event-type-filter").value : "";
      const query = new URLSearchParams();
      if (filter) query.set("channel_id", filter);
      if (eventType) query.set("event_type", eventType);
      if (showLoading) {
        feedback.hidden = false;
        feedback.className = "list-feedback";
        feedback.textContent = "\u6B63\u5728\u8BFB\u53D6\u2026";
      }
      try {
        const data = await api(`/api/${kind}${query.toString() ? `?${query}` : ""}`);
        if (sequence !== state.requests[kind]) return;
        const items = Array.isArray(data.items) ? data.items : [];
        if (kind === "recordings") renderRecordings(items);
        else renderEvents(items);
        feedback.hidden = !!items.length;
        feedback.className = "list-feedback";
        feedback.textContent = kind === "recordings" ? "\u6682\u65E0\u5DF2\u5B8C\u6210\u7684\u5F55\u50CF\u3002\u8BF7\u5F00\u542F\u901A\u9053\u5F55\u50CF\uFF0C\u7B49\u5F85\u9996\u4E2A\u7247\u6BB5\u4FDD\u5B58\u3002" : filter || eventType ? "\u6CA1\u6709\u7B26\u5408\u5F53\u524D\u7B5B\u9009\u6761\u4EF6\u7684\u4E8B\u4EF6\uFF0C\u53EF\u5207\u6362\u901A\u9053\u6216\u4E8B\u4EF6\u7C7B\u578B\u3002" : "\u6682\u65E0\u4E8B\u4EF6\u3002\u68C0\u6D4B\u5230\u8FD0\u52A8\u7684\u4EBA\u3001\u8F66\u6216\u52A8\u7269\u65F6\u4FDD\u5B58\u4E8B\u4EF6\uFF1B\u4EC5\u4EBA\u53C2\u4E0E\u957F\u65F6\u95F4\u505C\u7559\u68C0\u6D4B\uFF0C\u540C\u4E00\u76EE\u6807\u4E0D\u91CD\u590D\u65B0\u589E\u3002";
      } catch (error) {
        if (sequence !== state.requests[kind]) return;
        feedback.hidden = false;
        feedback.className = "list-feedback error";
        feedback.textContent = `${error.message} \u53EF\u4EE5\u70B9\u51FB\u5237\u65B0\u91CD\u8BD5\u3002`;
      }
    }
    function inputField(label, key, value, options = {}) {
      const wrapper = el("label", options.wide ? "wide" : "", label);
      const input = el("input");
      input.type = options.type || "text";
      input.dataset.key = key;
      input.value = value != null ? value : "";
      for (const property of ["min", "max", "step", "maxLength", "placeholder", "list"]) {
        if (options[property] !== void 0) input.setAttribute(property, options[property]);
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
      const targets = state.storageTargets || [{ id: "internal", label: "\u5185\u7F6E\u5B58\u50A8", available: true, writable: true }];
      select.replaceChildren();
      for (const target of targets) {
        const usable = target.available !== false && target.writable !== false;
        const option = el("option", "", `${target.label || (target.id === "internal" ? "\u5185\u7F6E\u5B58\u50A8" : "\u5916\u90E8\u5B58\u50A8")}${!usable ? target.available === false ? " \xB7 \u672A\u5C31\u7EEA" : " \xB7 \u53EA\u8BFB" : metricNumber(target.free_bytes) !== null ? ` \xB7 \u5269\u4F59 ${bytesText(target.free_bytes)}` : ""}`);
        option.value = target.id;
        option.disabled = !usable;
        select.append(option);
      }
      if (!targets.some((target) => target.id === selectedId)) {
        const missing = el("option", "", selectedId === "internal" ? "\u5185\u7F6E\u5B58\u50A8 \xB7 \u72B6\u6001\u672A\u77E5" : "\u5DF2\u9009\u5916\u90E8\u5B58\u50A8 \xB7 \u5C1A\u672A\u63A5\u5165");
        missing.value = selectedId;
        missing.disabled = true;
        select.append(missing);
      }
      select.value = selectedId;
      updateStorageTargetInfo();
    }
    function updateStorageTargetInfo() {
      var _a, _b, _c;
      const selectedId = $("#storage-target").value;
      const info = $("#storage-target-info");
      const target = (_a = state.storageTargets) == null ? void 0 : _a.find((item2) => item2.id === selectedId);
      const savedId = ((_c = (_b = state.config) == null ? void 0 : _b.storage) == null ? void 0 : _c.target_id) || "internal";
      info.classList.remove("error");
      if (state.storageTargetError) {
        info.textContent = `\u4ECB\u8D28\u5217\u8868\u8BFB\u53D6\u5931\u8D25\uFF1A${state.storageTargetError} \u5F53\u524D\u4FDD\u5B58\u4F4D\u7F6E\uFF1A${savedId === "internal" ? "\u5185\u7F6E\u5B58\u50A8" : "\u5916\u90E8\u5B58\u50A8"}\u3002\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\u3002`;
        info.classList.add("error");
      } else if (!state.storageTargets) {
        info.textContent = "\u6B63\u5728\u8BFB\u53D6\u5B58\u50A8\u4ECB\u8D28\u2026";
      } else if (!target || target.available === false || target.writable === false) {
        info.textContent = `${(target == null ? void 0 : target.label) || "\u6240\u9009\u4ECB\u8D28"}${(target == null ? void 0 : target.available) !== false && (target == null ? void 0 : target.writable) === false ? "\u4E3A\u53EA\u8BFB\u72B6\u6001" : "\u5C1A\u672A\u63A5\u5165\u6216\u672A\u6302\u8F7D"}\u3002\u8BF7\u63A5\u5165\u53EF\u5199\u4ECB\u8D28\u540E\u5237\u65B0\uFF0C\u6216\u9009\u62E9\u5185\u7F6E\u5B58\u50A8\u3002`;
        info.classList.add("error");
      } else {
        const noExternal = !state.storageTargets.some((item2) => item2.id !== "internal" && item2.available !== false);
        const context = selectedId === savedId ? "\u5F53\u524D\u4F7F\u7528" : "\u4FDD\u5B58\u540E\u5C06\u4F7F\u7528";
        info.textContent = `${noExternal ? "\u672A\u53D1\u73B0\u5DF2\u6302\u8F7D\u7684 SD \u5361\u6216\u5176\u4ED6\u5916\u90E8\u4ECB\u8D28\u3002" : ""}${context}${target.label || (selectedId === "internal" ? "\u5185\u7F6E\u5B58\u50A8" : "\u5916\u90E8\u5B58\u50A8")}\uFF0C\u5269\u4F59 ${bytesText(target.free_bytes)} / \u603B\u8BA1 ${bytesText(target.total_bytes)}${target.filesystem ? ` \xB7 ${target.filesystem}` : ""}${target.mountpoint ? ` \xB7 ${target.mountpoint}` : ""}\u3002`;
      }
    }
    async function loadStorageTargets() {
      var _a, _b;
      const button = $("#refresh-storage-targets");
      if (button.disabled) return;
      button.disabled = true;
      try {
        const data = await api("/api/storage/targets");
        if (!Array.isArray(data.targets)) throw new Error("\u8BBE\u5907\u672A\u8FD4\u56DE\u5B58\u50A8\u4ECB\u8D28\u5217\u8868\u3002");
        state.storageTargets = data.targets.filter((target) => target && typeof target.id === "string");
        state.storageTargetError = "";
        renderStorageTargets($("#storage-target").value || ((_b = (_a = state.config) == null ? void 0 : _a.storage) == null ? void 0 : _b.target_id) || data.selected_id || "internal");
        if (state.status) updateSystem(state.status);
      } catch (error) {
        state.storageTargetError = error.message;
        updateStorageTargetInfo();
      } finally {
        button.disabled = false;
        if (ui.onDiagnostics) ui.onDiagnostics();
      }
    }
    function updateCopySelection() {
      const checks = $$("#copy-targets input");
      const selected = checks.filter((input) => input.checked).length;
      $("#copy-select-all").checked = !!checks.length && selected === checks.length;
      $("#copy-select-all").indeterminate = selected > 0 && selected < checks.length;
      $("#apply-copy").disabled = !selected;
      $("#apply-copy").textContent = selected ? `\u590D\u5236\u5230 ${selected} \u4E2A\u901A\u9053` : "\u590D\u5236\u5230\u6240\u9009\u901A\u9053";
    }
    function openCopyDialog(sourceId) {
      if (!state.config || state.saving) return;
      state.copySourceId = String(sourceId);
      const sourceCard = $$("#channel-settings > .settings-card").find((card) => card.dataset.channelId === state.copySourceId);
      const sourceName = sourceCard ? $('[data-key="name"]', sourceCard).value : channelName(sourceId);
      $("#copy-description").textContent = `\u5C06\u300C${sourceName || `AHD ${sourceId}`}\u300D\u7684\u5F53\u524D\u53C2\u6570\u590D\u5236\u5230\u5176\u4ED6\u901A\u9053\u3002`;
      const targets = $("#copy-targets");
      targets.replaceChildren();
      for (const card of $$("#channel-settings > .settings-card")) {
        if (card.dataset.channelId === state.copySourceId) continue;
        const name = $('[data-key="name"]', card).value || `AHD ${card.dataset.channelId}`;
        const label = checkField(`${card.dataset.channelId} \xB7 ${name}`, "copy-target", false);
        $("input", label).value = card.dataset.channelId;
        targets.append(label);
      }
      updateCopySelection();
      $("#copy-dialog").showModal();
    }
    function applyChannelCopy() {
      const ids = $$("#copy-targets input:checked").map((input) => input.value);
      if (!ids.length || !state.copySourceId) return;
      const sourceCard = $$("#channel-settings > .settings-card").find((card) => card.dataset.channelId === state.copySourceId);
      if (!sourceCard) return;
      for (const input of $$("input, select", sourceCard)) {
        if (!input.checkValidity()) {
          toast("\u6765\u6E90\u901A\u9053\u5B58\u5728\u65E0\u6548\u53C2\u6570\uFF0C\u8BF7\u5148\u4FEE\u6B63\u540E\u518D\u590D\u5236\u3002");
          return;
        }
      }
      try {
        const draft = readSettings(false);
        const source = draft.channels.find((channel) => String(channel.id) === state.copySourceId);
        validateChannel(source);
        for (const channel of draft.channels) {
          if (!ids.includes(String(channel.id))) continue;
          for (const key of ["width", "height", "fps", "preview_fps", "recording", "detection"]) channel[key] = JSON.parse(JSON.stringify(source[key]));
        }
        renderSettings(draft, false);
        setDirty(true);
        $("#copy-dialog").close();
        settingsFeedback(`\u5DF2\u5C06 AHD ${state.copySourceId} \u7684\u53C2\u6570\u590D\u5236\u5230 ${ids.length} \u4E2A\u901A\u9053\u7684\u8349\u7A3F\uFF0C\u63A5\u7EBF\u6620\u5C04\u4FDD\u6301\u539F\u6837\u3002\u70B9\u51FB\u201C\u4FDD\u5B58\u5E76\u5E94\u7528\u201D\u4F7F\u4FEE\u6539\u751F\u6548\u3002`);
        toast(`\u5DF2\u590D\u5236\u5230 ${ids.length} \u4E2A\u901A\u9053 \xB7 \u7B49\u5F85\u4FDD\u5B58`);
      } catch (error) {
        toast(error.message);
      }
    }
    function renderSettings(config, resetDirty = true) {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s, _t, _u;
      const fragment = document.createDocumentFragment();
      for (const channel of config.channels || []) {
        const card = el("section", "settings-card");
        card.dataset.channelId = channel.id;
        const header = el("div", "settings-channel-header");
        const title = el("h2");
        title.append(el("span", "camera-number", String(channel.id).padStart(2, "0")), el("span", "", `AHD ${channel.id}`));
        const actions = el("div", "settings-channel-actions");
        const copy = el("button", "button secondary small", "\u5E94\u7528\u5230\u5176\u4ED6\u901A\u9053");
        copy.type = "button";
        copy.title = "\u590D\u5236\u53C2\u6570\uFF0C\u4FDD\u7559\u63A5\u7EBF\u6620\u5C04";
        copy.addEventListener("click", () => openCopyDialog(channel.id));
        actions.append(copy, checkField("\u542F\u7528\u901A\u9053", "enabled", channel.enabled, "channel-enabled"));
        header.append(title, actions);
        const basic = el("div", "form-grid");
        basic.append(inputField("\u901A\u9053\u540D\u79F0", "name", channel.name, { maxLength: 40 }), inputField("\u89C6\u9891\u8BBE\u5907", "source", channel.source, { list: "device-options", placeholder: "/dev/video0" }), inputField("\u56FE\u50CF\u5BBD\u5EA6\uFF08\u50CF\u7D20\uFF09", "width", channel.width, { type: "number", min: 160, max: 1920, step: 8 }), inputField("\u56FE\u50CF\u9AD8\u5EA6\uFF08\u50CF\u7D20\uFF09", "height", channel.height, { type: "number", min: 120, max: 1080, step: 8 }));
        const cropLabel = el("label", "", "\u753B\u9762\u533A\u57DF");
        const cropSelect = el("select");
        cropSelect.dataset.key = "crop";
        for (const [label, crop] of cropChoices) {
          const option = el("option", "", label);
          option.value = JSON.stringify(crop);
          cropSelect.append(option);
        }
        const currentCrop = JSON.stringify(channel.crop || [0, 0, 1, 1]);
        if (!cropChoices.some(([, crop]) => JSON.stringify(crop) === currentCrop)) {
          const option = el("option", "", "\u5F53\u524D\u81EA\u5B9A\u4E49\u533A\u57DF");
          option.value = currentCrop;
          cropSelect.append(option);
        }
        cropSelect.value = currentCrop;
        cropLabel.append(cropSelect);
        basic.append(cropLabel);
        const recording = el("div", "subsection");
        recording.append(sectionHeader("\u8FDE\u7EED\u5F55\u50CF", checkField("\u542F\u7528\u5F55\u50CF", "recording.enabled", (_a = channel.recording) == null ? void 0 : _a.enabled)));
        const recordingGrid = el("div", "form-grid");
        const segmentLabel = el("label", "", "\u5F55\u50CF\u7247\u6BB5\u957F\u5EA6");
        const segment = el("select");
        segment.dataset.key = "recording.segment_minutes";
        for (const minutes of [.../* @__PURE__ */ new Set([1, 3, 5, 10, ((_b = channel.recording) == null ? void 0 : _b.segment_minutes) || 3])].sort((a, b) => a - b)) {
          const option = el("option", "", `${minutes} \u5206\u949F`);
          option.value = minutes;
          segment.append(option);
        }
        segment.value = ((_c = channel.recording) == null ? void 0 : _c.segment_minutes) || 3;
        segmentLabel.append(segment);
        const fps = (_d = channel.fps) != null ? _d : 25;
        recordingGrid.append(inputField("\u5F55\u50CF\u76EE\u6807\u5E27\u7387\uFF08fps\uFF09", "fps", fps, { type: "number", min: 1, max: 30, step: 1 }), inputField("\u9884\u89C8\u76EE\u6807\u5E27\u7387\uFF08fps\uFF09", "preview_fps", (_e = channel.preview_fps) != null ? _e : Math.min(16, fps), { type: "number", min: 1, max: 30, step: 1 }), segmentLabel);
        recording.append(recordingGrid, el("p", "footnote", "\u53EF\u8BBE\u7F6E 1\u201330 fps\uFF0C\u9884\u89C8\u76EE\u6807\u4E0D\u80FD\u9AD8\u4E8E\u5F55\u50CF\u76EE\u6807\u3002\u9ED8\u8BA4\u5F55\u50CF 25 fps\u3001\u9884\u89C8 16 fps\uFF1B\u5B9E\u9645\u5E27\u7387\u53D7\u8F93\u5165\u4FE1\u53F7\u3001\u8BBE\u5907\u8D1F\u8F7D\u4E0E\u7F51\u7EDC\u5F71\u54CD\uFF0C\u53EF\u5728\u5B9E\u65F6\u753B\u9762\u67E5\u770B\u3002"));
        const detection = el("div", "subsection");
        detection.append(sectionHeader("\u667A\u80FD\u4FA6\u6D4B", checkField("\u542F\u7528\u4FA6\u6D4B", "detection.enabled", (_f = channel.detection) == null ? void 0 : _f.enabled)));
        const detectionGrid = el("div", "form-grid");
        const categories = el("div", "form-field wide");
        categories.append(el("span", "", "\u8BC6\u522B\u76EE\u6807"));
        const checks = el("div", "category-options");
        for (const [key, label] of Object.entries(categoryNames)) checks.append(checkField(label, `category.${key}`, (_h = (_g = channel.detection) == null ? void 0 : _g.categories) == null ? void 0 : _h.includes(key)));
        categories.append(checks);
        detectionGrid.append(categories, inputField("\u4EBA\u5458\u505C\u7559\u9608\u503C\uFF08\u79D2\uFF09", "detection.threshold_seconds", (_j = (_i = channel.detection) == null ? void 0 : _i.threshold_seconds) != null ? _j : 3, { type: "number", min: 0.1, max: 3600, step: 0.1 }), inputField("\u8BC6\u522B\u7F6E\u4FE1\u5EA6\uFF080\u20141\uFF09", "detection.confidence", (_l = (_k = channel.detection) == null ? void 0 : _k.confidence) != null ? _l : 0.35, { type: "number", min: 0.1, max: 0.99, step: 0.01 }), inputField("\u4FA6\u6D4B\u95F4\u9694\uFF08\u79D2\uFF09", "detection.sample_interval", (_n = (_m = channel.detection) == null ? void 0 : _m.sample_interval) != null ? _n : 1, { type: "number", min: 0.2, max: 10, step: 0.1 }), inputField("\u77ED\u6682\u6D88\u5931\u5BB9\u5FCD\uFF08\u79D2\uFF09", "detection.lost_tolerance_seconds", (_p = (_o = channel.detection) == null ? void 0 : _o.lost_tolerance_seconds) != null ? _p : 2, { type: "number", min: 0.2, max: 30, step: 0.1 }));
        detection.append(detectionGrid, el("p", "footnote", "\u8FD0\u52A8\u7684\u4EBA\u3001\u8F66\u3001\u52A8\u7269\u4FDD\u5B58\u666E\u901A\u4E8B\u4EF6\uFF1B\u4EC5\u4EBA\u53C2\u4E0E\u957F\u65F6\u95F4\u505C\u7559\u68C0\u6D4B\uFF0C\u9759\u6B62\u7684\u4EBA\u4E5F\u53EF\u89E6\u53D1\u505C\u7559\u4E8B\u4EF6\u3002\u540C\u4E00\u76EE\u6807\u6301\u7EED\u51FA\u73B0\u53EA\u4FDD\u5B58\u4E00\u6761\uFF0C\u4EBA\u5458\u505C\u7559\u8FBE\u6807\u66F4\u65B0\u539F\u4E8B\u4EF6\u3002\u76EE\u6807\u79BB\u5F00\u8D85\u8FC7\u6D88\u5931\u5BB9\u5FCD\u540E\u518D\u51FA\u73B0\uFF0C\u6309\u65B0\u76EE\u6807\u786E\u8BA4\u3002\u6D88\u5931\u5BB9\u5FCD\u81F3\u5C11\u4E3A\u4FA6\u6D4B\u95F4\u9694\u7684 2.5 \u500D\uFF0C\u4EE5\u5BB9\u5FCD\u4E00\u6B21\u6F0F\u68C0\u3002\u9ED8\u8BA4\u7F6E\u4FE1\u5EA6 0.35\uFF0C\u8C03\u4F4E\u53EF\u51CF\u5C11\u6F0F\u68C0\uFF0C\u4E5F\u53EF\u80FD\u589E\u52A0\u8BEF\u62A5\u3002\u4FA6\u6D4B\u95F4\u9694\u8D8A\u77ED\uFF0C\u5904\u7406\u8D1F\u8F7D\u8D8A\u9AD8\u3002"));
        card.append(header, basic, el("p", "footnote", "AHD1 \u4F7F\u7528 /dev/video5 \u7684\u5B8C\u6574\u753B\u9762\u3002AHD2\u20145 \u5171\u7528 /dev/video0 \u7684\u56DB\u4E2A\u533A\u57DF\uFF1B\u63A5\u5165\u5176\u4ED6\u6444\u50CF\u5934\u540E\uFF0C\u53EF\u8C03\u6574\u533A\u57DF\u4E0E\u63D2\u53E3\u7684\u5BF9\u5E94\u5173\u7CFB\u3002"), recording, detection);
        card.onclick = () => ui.openEvent(item);
        fragment.append(card);
      }
      $("#channel-settings").replaceChildren(fragment);
      $("#storage-max-gb").value = (_r = (_q = config.storage) == null ? void 0 : _q.max_gb) != null ? _r : 20;
      $("#storage-min-free-gb").value = (_t = (_s = config.storage) == null ? void 0 : _s.min_free_gb) != null ? _t : 2;
      renderStorageTargets(((_u = config.storage) == null ? void 0 : _u.target_id) || "internal");
      if (resetDirty) setDirty(false);
      if (ui.onConfig) ui.onConfig();
      for (const filter of [$("#recording-filter"), $("#event-filter")]) {
        const selected = filter.value;
        filter.replaceChildren();
        const all = el("option", "", "\u5168\u90E8\u901A\u9053");
        all.value = "";
        filter.append(all);
        for (const channel of config.channels || []) {
          const option = el("option", "", `${channel.id} \xB7 ${channel.name}`);
          option.value = channel.id;
          filter.append(option);
        }
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
      $("#save-state").textContent = dirty ? "\u6709\u5C1A\u672A\u4FDD\u5B58\u7684\u4FEE\u6539" : state.config ? "\u6240\u6709\u8BBE\u7F6E\u5DF2\u4FDD\u5B58" : "\u8BBE\u7F6E\u5C1A\u672A\u52A0\u8F7D";
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
      } catch (error) {
        settingsFeedback(error.message, true);
      }
    }
    function validateChannel(channel) {
      if (!Number.isInteger(channel.fps) || channel.fps < 1 || channel.fps > 30) throw new Error(`AHD ${channel.id} \u7684\u5F55\u50CF\u76EE\u6807\u5E27\u7387\u987B\u4E3A 1\u201330 \u7684\u6574\u6570\u3002`);
      if (!Number.isInteger(channel.preview_fps) || channel.preview_fps < 1 || channel.preview_fps > 30 || channel.preview_fps > channel.fps) throw new Error(`AHD ${channel.id} \u7684\u9884\u89C8\u5E27\u7387\u987B\u4E3A 1\u201330 \u7684\u6574\u6570\uFF0C\u4E14\u4E0D\u80FD\u9AD8\u4E8E\u5F55\u50CF\u76EE\u6807\u5E27\u7387\u3002`);
      if (channel.detection.lost_tolerance_seconds < channel.detection.sample_interval) throw new Error(`AHD ${channel.id} \u7684\u77ED\u6682\u6D88\u5931\u5BB9\u5FCD\u65F6\u95F4\u4E0D\u80FD\u5C0F\u4E8E\u4FA6\u6D4B\u95F4\u9694\u3002`);
      if (channel.detection.enabled && !channel.detection.categories.length) throw new Error(`AHD ${channel.id} \u5DF2\u5F00\u542F\u4FA6\u6D4B\uFF0C\u8BF7\u81F3\u5C11\u9009\u62E9\u4E00\u79CD\u8BC6\u522B\u76EE\u6807\u3002`);
    }
    function readSettings(validate = true) {
      var _a, _b;
      const config = JSON.parse(JSON.stringify(state.config));
      for (const card of $$("#channel-settings > .settings-card")) {
        const channel = config.channels.find((item2) => String(item2.id) === card.dataset.channelId);
        channel.recording = channel.recording || {};
        channel.detection = channel.detection || {};
        channel.detection.categories = [];
        for (const input of $$("[data-key]", card)) {
          const key = input.dataset.key;
          if (key === "crop") {
            channel.crop = JSON.parse(input.value);
            continue;
          }
          if (key.startsWith("category.")) {
            if (input.checked) channel.detection.categories.push(key.split(".")[1]);
            continue;
          }
          const value = input.type === "checkbox" ? input.checked : input.type === "number" || key === "recording.segment_minutes" ? Number(input.value) : input.value.trim();
          const parts = key.split(".");
          if (parts.length === 2) channel[parts[0]][parts[1]] = value;
          else channel[key] = value;
        }
        if (validate) validateChannel(channel);
      }
      const targetId = $("#storage-target").value;
      if (validate && targetId !== (((_a = state.config.storage) == null ? void 0 : _a.target_id) || "internal")) {
        const target = (_b = state.storageTargets) == null ? void 0 : _b.find((item2) => item2.id === targetId);
        if (!target || target.available === false || target.writable === false) throw new Error("\u6240\u9009\u5F55\u50CF\u4ECB\u8D28\u5F53\u524D\u4E0D\u53EF\u7528\uFF0C\u8BF7\u5237\u65B0\u4ECB\u8D28\u5217\u8868\u540E\u91CD\u8BD5\u3002");
      }
      config.storage = { ...config.storage, target_id: targetId, max_gb: Number($("#storage-max-gb").value), min_free_gb: Number($("#storage-min-free-gb").value) };
      return config;
    }
    async function saveSettings(event) {
      event.preventDefault();
      if (!state.config || state.saving) return;
      const invalid = Array.from($("#settings-form").elements).find((input) => input.willValidate && !input.validity.valid);
      if (invalid) {
        if (ui.onInvalid) ui.onInvalid(invalid);
        return;
      }
      let config;
      try {
        config = readSettings();
      } catch (error) {
        settingsFeedback(error.message, true);
        return;
      }
      state.saving = true;
      $("#save-settings").textContent = "\u6B63\u5728\u4FDD\u5B58\u2026";
      $("#settings-form").classList.add("saving");
      setDirty(state.dirty);
      try {
        const fresh = await api("/api/config");
        config = mergeChanges(state.config, config, fresh);
        config.channels.forEach(validateChannel);
        const response = await api("/api/config", { method: "PUT", body: JSON.stringify(config) });
        if (!response.ok) throw new Error(response.error || "\u4FDD\u5B58\u672A\u6210\u529F\uFF0C\u8BF7\u91CD\u8BD5\u3002");
        state.config = response.config || config;
        renderSettings(state.config);
        settingsFeedback("\u8BBE\u7F6E\u5DF2\u4FDD\u5B58\u5E76\u5E94\u7528\u3002\u53D7\u5F71\u54CD\u7684\u901A\u9053\u53EF\u80FD\u9700\u8981\u51E0\u79D2\u91CD\u65B0\u8FDE\u63A5\u3002");
        toast("\u8BBE\u7F6E\u5DF2\u4FDD\u5B58");
        syncStreams(true);
      } catch (error) {
        settingsFeedback(error.message, true);
      } finally {
        state.saving = false;
        $("#settings-form").classList.remove("saving");
        $("#save-settings").textContent = "\u4FDD\u5B58\u5E76\u5E94\u7528";
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
        for (const device of devices) {
          const option = el("option");
          option.value = device.path;
          option.label = device.name || device.path;
          $("#device-options").append(option);
        }
        $("#devices-summary").textContent = devices.length ? `\u68C0\u6D4B\u5230 ${devices.length} \u4E2A\u8BBE\u5907\uFF1A${devices.map((device) => `${device.path}${device.name ? `\uFF08${device.name}\uFF09` : ""}`).join("\u3001")}\u3002\u8BBE\u5907\u8282\u70B9\u4E0E AHD \u63D2\u53E3\u7684\u5BF9\u5E94\u5173\u7CFB\u8BF7\u4EE5\u5B9E\u9645\u753B\u9762\u4E3A\u51C6\u3002` : "\u672A\u53D1\u73B0\u89C6\u9891\u8BBE\u5907\u3002\u8BF7\u68C0\u67E5\u9A71\u52A8\u4E0E\u8FDE\u63A5\uFF1B\u4E5F\u53EF\u4EE5\u624B\u52A8\u586B\u5199\u8BBE\u5907\u8DEF\u5F84\u3002";
      } catch (error) {
        $("#devices-summary").textContent = error.message;
      } finally {
        button.disabled = false;
      }
    }
    buildCameras();
    Object.assign(ui, { state, el, api, toast, mediaUrl, bytesText, dateText, downloadLink, setPage, openCopyDialog, stopStream, openMedia });
    installHostUI(ui);
    $("#server-address").textContent = location.host;
    setDirty(false);
    $$(".nav-button").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));
    window.addEventListener("hashchange", () => setPage(location.hash.slice(1), false));
    $("#reconnect-streams").addEventListener("click", () => {
      syncStreams(true);
      if (!state.pollBusy) poll();
      toast("\u6B63\u5728\u91CD\u65B0\u8FDE\u63A5\u5404\u8DEF\u753B\u9762");
    });
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
    $("#copy-dialog").addEventListener("close", () => {
      state.copySourceId = null;
    });
    $("#settings-form").addEventListener("input", () => {
      if (state.config) setDirty(true);
    });
    $("#settings-form").addEventListener("change", () => {
      if (state.config) setDirty(true);
    });
    $("#settings-form").addEventListener("submit", saveSettings);
    $("#reload-settings").addEventListener("click", () => {
      if (state.config) {
        renderSettings(state.config);
        settingsFeedback("\u5DF2\u6062\u590D\u5230\u4E0A\u6B21\u4FDD\u5B58\u7684\u8BBE\u7F6E\u3002");
      } else loadConfig(true);
    });
    $("#close-media").addEventListener("click", () => $("#media-dialog").close());
    $("#media-dialog").addEventListener("close", () => {
      const video = $("video", $("#media-content"));
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      $("#media-content").replaceChildren();
    });
    document.addEventListener("visibilitychange", () => {
      clearTimeout(state.timer);
      syncStreams(true);
      if (!document.hidden && !state.pollBusy) poll();
    });
    window.addEventListener("beforeunload", (event) => {
      if (state.dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    window.addEventListener("pagehide", () => {
      clearTimeout(state.timer);
      for (const card of state.cards.values()) stopStream(card);
    });
    window.addEventListener("pageshow", (event) => {
      if (event.persisted && !state.pollBusy) poll();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") for (const card of $$(".camera-expanded")) card.classList.remove("camera-expanded");
    });
    window.addEventListener("resize", () => {
      for (const card of state.cards.values()) positionBoxes(card);
    });
    function updateClock() {
      $("#clock").textContent = (/* @__PURE__ */ new Date()).toLocaleString("zh-CN", { hour12: false });
    }
    updateClock();
    setInterval(updateClock, 1e3);
    setPage(location.hash.slice(1) || "live", false);
    loadDevices();
    poll();
  })();
})();
