/* ESP32 Mesh Telemetry dashboard client.
   Backend contract: /nodes, /nodes/{id}/history, /nodes/{id}/insights, /health, WS /live.
   Design rules: DESIGN.md. Chart colours come from the stylesheet tokens, never literals. */

const els = {
  headline: document.getElementById("health-headline"),
  segs: {
    live: document.getElementById("hb-live"),
    warn: document.getElementById("hb-warn"),
    stale: document.getElementById("hb-stale"),
  },
  wsPill: document.getElementById("ws-pill"),
  gwPill: document.getElementById("gw-pill"),
  banner: document.getElementById("banner"),
  bannerText: document.getElementById("banner-text"),
  requestDataBtn: document.getElementById("request-data-btn"),
  intervalForm: document.getElementById("interval-form"),
  intervalSeconds: document.getElementById("interval-seconds"),
  intervalApplyBtn: document.getElementById("interval-apply-btn"),
  deepSleepForm: document.getElementById("deep-sleep-form"),
  deepSleepSeconds: document.getElementById("deep-sleep-seconds"),
  deepSleepBtn: document.getElementById("deep-sleep-btn"),
  autoSleepForm: document.getElementById("auto-sleep-form"),
  autoSleepSeconds: document.getElementById("auto-sleep-seconds"),
  autoWakeGraceSeconds: document.getElementById("auto-wake-grace-seconds"),
  autoSleepToggleBtn: document.getElementById("auto-sleep-toggle-btn"),
  autoSleepStatus: document.getElementById("auto-sleep-status"),
  autoSleepStatusText: document.getElementById("auto-sleep-status-text"),
  meshCommandStatus: document.getElementById("mesh-command-status"),
  metricGrid: document.getElementById("metric-grid"),
  railCount: document.getElementById("rail-count"),
  railEmpty: document.getElementById("rail-empty"),
  stationList: document.getElementById("station-list"),
  insightsBlock: document.getElementById("insights-block"),
  insightsNode: document.getElementById("insights-node"),
  insightsUpdatedAt: document.getElementById("insights-updated-at"),
  insightsContent: document.getElementById("insights-content"),
  chartCanvas: document.getElementById("telemetry-chart"),
  chartFrame: document.getElementById("chart-frame"),
  chartEmpty: document.getElementById("chart-empty"),
  chartNode: document.getElementById("chart-node"),
  chartSeq: document.getElementById("chart-seq"),
  chartLegend: document.getElementById("chart-legend"),
  overviewTab: document.getElementById("overview-tab"),
  compareTab: document.getElementById("compare-tab"),
  overviewView: document.getElementById("overview-view"),
  compareView: document.getElementById("compare-view"),
  compareMeasurement: document.getElementById("compare-measurement"),
  compareCanvas: document.getElementById("compare-chart"),
  compareChartFrame: document.getElementById("compare-chart-frame"),
  compareEmpty: document.getElementById("compare-empty"),
  compareLegend: document.getElementById("compare-legend"),
  updatedAt: document.getElementById("updated-at"),
  chartTable: document.getElementById("chart-table"),
  eventLog: document.getElementById("event-log"),
  logEmpty: document.getElementById("log-empty"),
  chatSidebar: document.getElementById("chat-sidebar"),
  chatContextNode: document.getElementById("chat-context-node"),
  chatBlock: document.getElementById("chat-block"),
  aiModelTag: document.getElementById("ai-model-tag"),
  chatClearBtn: document.getElementById("chat-clear-btn"),
  chatExpandBtn: document.getElementById("chat-expand-btn"),
  chatCloseBtn: document.getElementById("chat-close-btn"),
  chatOpenBtn: document.getElementById("chat-open-btn"),
  chatMessages: document.getElementById("chat-messages"),
  chatForm: document.getElementById("chat-form"),
  chatInput: document.getElementById("chat-input"),
  chatSendBtn: document.getElementById("chat-send-btn"),
};

const STALE_S = 30;    // a reading older than this is suspect
const SILENT_S = 120;  // a station older than this counts as silent
const MAX_SAMPLES = 240;
const MAX_LOG = 60;

const METRICS = [
  { key: "temperature", label: "Temperature", unit: "°C", decimals: 1, axis: "left" },
  { key: "humidity", label: "Humidity", unit: "% RH", decimals: 0, axis: "right" },
];

const state = {
  selected: null,
  activeView: "overview",
  compareMetric: null,
  nodes: new Map(),
  samples: new Map(),
  historyLoaded: new Set(),
  historyLoading: new Set(),
  health: null,
  wsOpen: false,
  chatHistory: [],
  chatLoading: false,
  chatScope: "selected",
  meshCommandBusy: false,
  autoSleep: null,
  autoSleepStatusError: null,
  autoSleepRequestBusy: false,
  autoSleepStatusRequestBusy: false,
};

/* ---------- helpers ---------- */

const ageSeconds = (ts) => Math.max(0, (Date.now() - Date.parse(ts)) / 1000);

/* Friendly station name from NODE_ALIASES, falling back to the raw id. */
const nodeLabel = (nodeId) => (state.nodes.get(nodeId) || {}).displayName || nodeId;

function ageText(sec) {
  if (!Number.isFinite(sec)) return "—";
  if (sec < 3) return "just now";
  if (sec < 90) return `${Math.round(sec)} s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min ${Math.round(sec % 60)} s ago`;
  return `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

function stationState(sec) {
  if (!Number.isFinite(sec)) return "stale";
  if (sec <= STALE_S) return "live";
  if (sec <= SILENT_S) return "warning";
  return "stale";
}

function fmtClock(ts, withSeconds = true) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return withSeconds ? `${hm}:${p(d.getSeconds())}` : hm;
}

function token(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function rssiLevel(dbm) {
  if (!Number.isFinite(dbm)) return 0;
  if (dbm > -55) return 4;
  if (dbm > -70) return 3;
  if (dbm > -82) return 2;
  return 1;
}
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function pushLog(kind, nodeId, text) {
  if (els.logEmpty && els.logEmpty.isConnected) els.logEmpty.remove();
  const li = document.createElement("li");
  if (kind === "dropped") li.dataset.kind = "dropped";
  li.innerHTML = `<b>${escapeHtml(nodeLabel(nodeId))}</b><span>${new Date().toLocaleTimeString()} · ${escapeHtml(text)}</span>`;
  els.eventLog.prepend(li);
  while (els.eventLog.children.length > MAX_LOG) els.eventLog.lastChild.remove();
}

/* ---------- status pills + banner ---------- */

function setPill(pill, kind, label) {
  pill.dataset.state = kind;
  pill.querySelector("[data-value]").textContent = label;
}

function renderStatus() {
  if (!state.wsOpen) setPill(els.wsPill, "stale", "disconnected");
  else setPill(els.wsPill, "live", "connected");

  const h = state.health;
  if (!h) setPill(els.gwPill, "warning", "checking…");
  else if (h.gatewayConnected) setPill(els.gwPill, "live", "connected");
  else setPill(els.gwPill, "stale", "offline");

  let text = null;
  if (!state.wsOpen) text = "Disconnected from the dashboard stream — retrying…";
  else if (h && !h.gatewayConnected) {
    text = `Mesh gateway offline${h.gatewayMessage ? ` — ${h.gatewayMessage}` : ""}`;
  }
  updateMeshControls();
  renderAutoSleepStatus();
  if (!text) {
    els.banner.hidden = true;
    return;
  }
  els.banner.hidden = false;
  els.banner.dataset.kind = state.wsOpen ? "warning" : "stale";
  els.bannerText.textContent = text;
}

function updateMeshControls() {
  const enabled = Boolean(state.health && state.health.gatewayConnected) &&
    !state.meshCommandBusy && !state.autoSleepRequestBusy &&
    !(state.autoSleep && state.autoSleep.active);
  if (els.requestDataBtn) els.requestDataBtn.disabled = !enabled;
  if (els.intervalApplyBtn) els.intervalApplyBtn.disabled = !enabled;
  if (els.deepSleepBtn) els.deepSleepBtn.disabled = !enabled;
  if (
    els.meshCommandStatus &&
    !state.meshCommandBusy &&
    ["gateway unavailable", "ready"].includes(els.meshCommandStatus.textContent)
  ) {
    els.meshCommandStatus.textContent = enabled ? "ready" : "gateway unavailable";
  }
}

function renderAutoSleepStatus() {
  const cycle = state.autoSleep;
  const active = Boolean(cycle && cycle.active);
  const connected = Boolean(state.health && state.health.gatewayConnected);
  if (els.autoSleepToggleBtn) {
    els.autoSleepToggleBtn.disabled = state.autoSleepRequestBusy || (!active && !connected);
    els.autoSleepToggleBtn.textContent = active ? "STOP AUTO MODE" : "START AUTO MODE";
  }
  if (els.autoSleepSeconds) els.autoSleepSeconds.disabled = active || state.autoSleepRequestBusy;
  if (els.autoWakeGraceSeconds) els.autoWakeGraceSeconds.disabled = active || state.autoSleepRequestBusy;
  if (!els.autoSleepStatus) return;

  if (active) {
    els.autoSleepSeconds.value = String(cycle.sleepMs / 1000);
    els.autoWakeGraceSeconds.value = String(cycle.wakeGraceMs / 1000);
  }
  let phase = "stopped";
  let statusText = "AUTO MODE OFF";
  if (active && cycle.status === "wake_grace") {
    phase = "awake";
    statusText = `AWAKE · WAITING ${cycle.wakeGraceMs / 1000} SEC BEFORE SLEEP`;
  } else if (active && cycle.status === "sending_sleep") {
    phase = "sleeping";
    statusText = "SENDING SLEEP COMMAND…";
  } else if (active) {
    phase = "sleeping";
    statusText = `SLEEPING · ${cycle.sleepMs / 1000} SEC · WAKE WAIT ${cycle.wakeGraceMs / 1000} SEC`;
  } else if (state.autoSleepStatusError) {
    phase = "error";
    statusText = `STATUS ERROR · ${state.autoSleepStatusError}`;
  } else if (cycle && cycle.status === "error") {
    phase = "error";
    statusText = `STOPPED · ${cycle.error || "GATEWAY ERROR"}`;
  }
  if (els.autoSleepStatus) els.autoSleepStatus.dataset.phase = phase;
  if (els.autoSleepStatusText) {
    els.autoSleepStatusText.textContent = statusText;
  }
  const control = els.autoSleepStatus && els.autoSleepStatus.closest(".auto-sleep-control");
  if (control) {
    control.dataset.phase = phase;
  }
}

async function refreshAutoSleepStatus() {
  if (state.autoSleepRequestBusy || state.autoSleepStatusRequestBusy) return;
  state.autoSleepStatusRequestBusy = true;
  try {
    const res = await fetch("/api/mesh/auto-sleep");
    const result = await res.json();
    if (!res.ok) throw new Error(result.detail || `HTTP ${res.status}`);
    state.autoSleep = result;
    state.autoSleepStatusError = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read auto mode status.";
    state.autoSleepStatusError = `status unavailable: ${message}`;
  } finally {
    state.autoSleepStatusRequestBusy = false;
    renderAutoSleepStatus();
    updateMeshControls();
  }
}

async function toggleAutoSleep(event) {
  event.preventDefault();
  const active = Boolean(state.autoSleep && state.autoSleep.active);
  let options = { method: "DELETE" };
  if (!active) {
    const sleepMs = secondsToMilliseconds(els.autoSleepSeconds.value);
    const wakeGraceMs = secondsToMilliseconds(els.autoWakeGraceSeconds.value, true);
    if (sleepMs === null || sleepMs < 1) {
      state.autoSleepStatusError = "sleep time must be 0.001–4294967.295 seconds";
      renderAutoSleepStatus();
      return;
    }
    if (wakeGraceMs === null) {
      state.autoSleepStatusError = "wake-up wait must be 0–4294967.295 seconds";
      renderAutoSleepStatus();
      return;
    }
    options = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sleepMs, wakeGraceMs }),
    };
  }

  state.autoSleepRequestBusy = true;
  renderAutoSleepStatus();
  try {
    const res = await fetch("/api/mesh/auto-sleep", options);
    const result = await res.json();
    if (!res.ok) throw new Error(result.detail || `HTTP ${res.status}`);
    state.autoSleep = result;
    state.autoSleepStatusError = null;
    pushLog("info", "mesh", active ? "Auto sleep mode stopped." : "Auto sleep mode started.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Auto mode request failed.";
    state.autoSleepStatusError = `request failed: ${message}`;
    renderAutoSleepStatus();
    pushLog("dropped", "mesh", `auto mode failed: ${message}`);
  } finally {
    state.autoSleepRequestBusy = false;
    renderAutoSleepStatus();
    updateMeshControls();
  }
}

function secondsToMilliseconds(value, allowZero = false) {
  const seconds = Number(value);
  const minSeconds = allowZero ? 0 : 0.001;
  if (!Number.isFinite(seconds) || seconds < minSeconds || seconds > 4294967.295) {
    return null;
  }
  const milliseconds = seconds * 1000;
  const rounded = Math.round(milliseconds);
  return Math.abs(milliseconds - rounded) < 1e-7 ? rounded : null;
}

async function sendMeshCommand(command, milliseconds) {
  state.meshCommandBusy = true;
  updateMeshControls();
  els.meshCommandStatus.textContent = "sending…";
  try {
    const body = { command };
    if (command === "CHANGE_INTERVAL") body.intervalMs = milliseconds;
    if (command === "DEEP_SLEEP") body.sleepMs = milliseconds;
    const res = await fetch("/api/mesh/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.detail || `HTTP ${res.status}`);
    const status = command === "SEND_DATA"
      ? "SEND_DATA sent to observer; awaiting node telemetry."
      : command === "CHANGE_INTERVAL"
        ? `Report interval ${milliseconds / 1000} sec sent to observer.`
        : `DEEP_SLEEP ${milliseconds / 1000} sec sent to observer.`;
    els.meshCommandStatus.textContent = status;
    pushLog("info", "mesh", status);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Command failed.";
    els.meshCommandStatus.textContent = `Command failed: ${message}`;
    pushLog("dropped", "mesh", `command failed: ${message}`);
  } finally {
    state.meshCommandBusy = false;
    updateMeshControls();
  }
}

function initMeshControls() {
  if (els.requestDataBtn) {
    els.requestDataBtn.addEventListener("click", () => sendMeshCommand("SEND_DATA"));
  }
  if (els.intervalForm) {
    els.intervalForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const intervalMs = secondsToMilliseconds(els.intervalSeconds.value);
      if (intervalMs === null || intervalMs < 1) {
        els.meshCommandStatus.textContent = "Enter an interval from 0.001 to 4294967.295 seconds.";
        return;
      }
      sendMeshCommand("CHANGE_INTERVAL", intervalMs);
    });
  }
  if (els.deepSleepForm) {
    els.deepSleepForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const sleepMs = secondsToMilliseconds(els.deepSleepSeconds.value);
      if (sleepMs === null || sleepMs < 1) {
        els.meshCommandStatus.textContent = "Enter a sleep duration from 0.001 to 4294967.295 seconds.";
        return;
      }
      sendMeshCommand("DEEP_SLEEP", sleepMs);
    });
  }
  if (els.autoSleepForm) {
    els.autoSleepForm.addEventListener("submit", toggleAutoSleep);
  }
  refreshAutoSleepStatus();
  window.setInterval(refreshAutoSleepStatus, 1000);
  updateMeshControls();
}

/* ---------- stations / nodes ---------- */

function upsertNode(node) {
  if (!node || !node.nodeId) return;
  const prev = state.nodes.get(node.nodeId) || {};
  const mergedPayload = { ...(prev.payload || {}), ...(node.payload || {}) };
  const mergedUnits = { ...(prev.units || {}), ...(node.units || {}) };
  state.nodes.set(node.nodeId, {
    ...prev,
    ...node,
    payload: mergedPayload,
    units: mergedUnits,
  });
}
function nodeSnapshot(id) {
  const node = state.nodes.get(id);
  const samples = state.samples.get(id) || [];
  return { node, samples, last: samples[samples.length - 1] };
}

function renderRoster() {
  const nodes = [...state.nodes.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  els.railCount.textContent = String(nodes.length);
  if (els.railEmpty.isConnected) els.railEmpty.style.display = nodes.length ? "none" : "";

  const currentIds = new Set(nodes.map((n) => n.nodeId));
  const existingRows = new Map();
  els.stationList.querySelectorAll(".station-row").forEach((el) => {
    const id = el.dataset.nodeId;
    if (id && currentIds.has(id)) {
      existingRows.set(id, el);
    } else {
      el.remove();
    }
  });

  for (const node of nodes) {
    const age = ageSeconds(node.timestamp);
    const st = stationState(age);
    const hasRssi = node.rssi !== null && node.rssi !== undefined && Number.isFinite(Number(node.rssi));
    const rssi = hasRssi ? Number(node.rssi) : NaN;
    const bat = Number(node.batteryLevel);
    const isSelected = String(node.nodeId === state.selected);
    const srcText = node.rssiSourceNodeId ? ` via ${nodeLabel(node.rssiSourceNodeId)}` : "";

    let row = existingRows.get(node.nodeId);
    if (!row) {
      row = document.createElement("button");
      row.type = "button";
      row.className = "station-row";
      row.dataset.nodeId = node.nodeId;
      row.addEventListener("click", () => selectStation(node.nodeId));
      els.stationList.appendChild(row);
    }

    row.title = `${node.nodeId} — ${st}${srcText}`;
    row.dataset.selected = isSelected;
    row.setAttribute("aria-pressed", isSelected);
    row.innerHTML = `
      <span class="station-id">${escapeHtml(node.displayName || node.nodeId)}</span>
      <span class="station-meta">
        <span class="sig-bars" data-level="${hasRssi ? rssiLevel(rssi) : 0}">
          <i class="sig-bar"></i><i class="sig-bar"></i><i class="sig-bar"></i><i class="sig-bar"></i>
        </span>
        <span>${hasRssi ? `${rssi} dBm` : "RSSI UNAVAILABLE"}</span>
        ${Number.isInteger(node.hops) ? `<span>${node.hops}h</span>` : ""}
        <span>bat ${Number.isFinite(bat) ? `${Math.round(bat)}%` : "—"}</span>
      </span>
      <span class="station-age" data-state="${st}">${ageText(age)}</span>`;
  }
}

function metricCode(key) {
  return key.split(/[._\s-]/).pop().toUpperCase();
}

function formatMetricLabel(key) {
  const code = metricCode(key);
  if (code === "L") return "Relative brightness";
  if (code === "T") return "Temperature";
  if (code === "H") return "Humidity";
  if (code === "P") return "Pressure";

  const lower = key.toLowerCase();
  if (lower.includes("temp")) return "Temperature";
  if (lower.includes("hum")) return "Humidity";
  if (lower.includes("ldr")) return "Light (LDR)";
  return key;
}

function metricDefaultUnit(key) {
  const code = metricCode(key);
  if (code === "T") return "°C";
  if (code === "H") return "%";
  if (code === "P") return "Pa";

  const lower = key.toLowerCase();
  if (lower.includes("temp")) return "°C";
  if (lower.includes("hum")) return "%";
  if (lower.includes("ldr")) return "adc";
  return "";
}

function metricDecimals(key) {
  const code = metricCode(key);
  return code === "H" || key.toLowerCase().includes("hum") || key.toLowerCase().includes("ldr") ? 0 : 1;
}

function metricCards(values, node) {
  const payload = (node && node.payload) || {};
  const cards = [];
  const units = (node && node.units) || {};

  for (const [k, v] of Object.entries(payload)) {
    if (!Number.isFinite(Number(v)) || cards.length >= 4) continue;
    const label = formatMetricLabel(k);
    const code = metricCode(k);
    const unit = ["L", "T", "H", "P"].includes(code) ? metricDefaultUnit(k) : (units[k] || metricDefaultUnit(k));
    const decimals = metricDecimals(k);
    cards.push({ label, unit, decimals, value: Number(v), key: k });
  }
  // Authoritative signal metric: "LAST-HOP RSSI"
  const hasRssi = node && node.rssi !== null && node.rssi !== undefined && Number.isFinite(Number(node.rssi));
  if (hasRssi) {
    const subParts = [];
    if (node.rssiSourceNodeId) subParts.push(`via ${nodeLabel(node.rssiSourceNodeId)}`);
    if (Number.isInteger(node.hops)) subParts.push(`${node.hops} hop${node.hops === 1 ? "" : "s"}`);
    cards.push({
      label: "LAST-HOP RSSI",
      unit: "dBm",
      decimals: 0,
      value: Number(node.rssi),
      sub: subParts.join(" · "),
    });
  } else {
    cards.push({
      label: "LAST-HOP RSSI",
      unit: "",
      decimals: 0,
      value: NaN,
      text: "RSSI UNAVAILABLE",
    });
  }

  const bat = node ? Number(node.batteryLevel) : NaN;
  if (cards.length < 4 && Number.isFinite(bat)) {
    cards.push({ label: "Battery", unit: "%", decimals: 0, value: bat });
  }
  return cards;
}

function renderMetrics() {
  if (!state.selected) {
    els.metricGrid.innerHTML =
      "<p class='empty-note'>no telemetry yet — waiting for the first station report</p>";
    return;
  }

  const { node, last } = nodeSnapshot(state.selected);
  const payload = (node && node.payload) || last || {};
  const ts = (last && last.timestamp) || (node && node.timestamp);
  const age = ts ? ageSeconds(ts) : NaN;
  const st = stationState(age);

  const cards = metricCards(payload, node);
  if (!cards.length) {
    els.metricGrid.innerHTML =
      `<p class='empty-note'>${state.selected} has not reported any numeric readings yet.</p>`;
    return;
  }

  const ageLine =
    ts ? `${fmtClock(ts)} · ${st === "stale" ? "not reporting, last seen " + ageText(age) : ageText(age)}` : "no data";

  const existingCards = els.metricGrid.querySelectorAll(".metric-primary, .metric-cell");
  if (existingCards.length === cards.length) {
    let structureMatches = true;
    for (let i = 0; i < cards.length; i++) {
      const cardEl = existingCards[i];
      const labelEl = cardEl.querySelector(".metric-label");
      if (!labelEl || labelEl.textContent !== cards[i].label) {
        structureMatches = false;
        break;
      }
    }
    if (structureMatches) {
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        const cardEl = existingCards[i];
        cardEl.dataset.stale = String(st === "stale");
        const tag = cardEl.querySelector(".tag");
        if (tag) {
          tag.dataset.state = st;
          tag.textContent = st.toUpperCase();
        }
        const valEl = cardEl.querySelector(".metric-value");
        if (valEl) {
          if (c.text) {
            valEl.className = "metric-value text-val";
            valEl.textContent = c.text;
          } else {
            valEl.className = "metric-value";
            valEl.textContent = Number.isFinite(c.value) ? c.value.toFixed(c.decimals) : "--";
          }
        }
        const unitEl = cardEl.querySelector(".metric-unit");
        if (unitEl) unitEl.textContent = c.unit || "";
        const subEl = cardEl.querySelector(".metric-sub");
        if (subEl) subEl.textContent = c.sub || "";
        const ageEl = cardEl.querySelector(".metric-age");
        if (ageEl) ageEl.textContent = ageLine;
      }
      return;
    }
  }

  const cell = (c, primary) => {
    const valHtml = c.text
      ? `<h2 class="metric-value text-val">${c.text}</h2>`
      : `<h2 class="metric-value">${Number.isFinite(c.value) ? c.value.toFixed(c.decimals) : "--"}</h2>`;
    const subHtml = c.sub ? `<span class="metric-sub">${c.sub}</span>` : "";
    return `
    <div class="${primary ? "metric-primary" : "metric-cell"}" data-stale="${st === "stale"}">
      <div class="metric-head">
        <span class="metric-label">${c.label}</span>
        <span class="tag" data-state="${st}">${st.toUpperCase()}</span>
      </div>
      <div class="metric-value-row">
        ${valHtml}
        ${c.unit ? `<span class="metric-unit">${c.unit}</span>` : ""}
      </div>
      ${subHtml}
      <span class="metric-age">${ageLine}</span>
    </div>`;
  };

  const [head, ...tail] = cards;
  els.metricGrid.innerHTML =
    (head ? cell(head, true) : "") +
    tail.map((c) => cell(c, false)).join("");
}

function renderHealth() {
  const counts = { live: 0, warning: 0, stale: 0 };
  for (const n of state.nodes.values()) counts[stationState(ageSeconds(n.timestamp))] += 1;
  const total = state.nodes.size;

  if (!total) {
    els.headline.innerHTML = "Waiting for stations…";
    delete els.headline.dataset.tone;
  } else {
    const degraded = counts.warning;
    const silent = counts.stale;
    els.headline.dataset.tone = silent ? "stale" : degraded ? "warning" : "live";
    els.headline.innerHTML =
      `<b>${counts.live}/${total}</b> stations reporting` +
      (degraded ? ` · ${degraded} degraded` : "") +
      (silent ? ` · ${silent} silent` : "");
  }

  const flex = (n) => `${total ? (n / total) * 100 : 0}%`;
  els.segs.live.style.flexBasis = flex(counts.live);
  els.segs.warn.style.flexBasis = flex(counts.warning);
  els.segs.stale.style.flexBasis = flex(counts.stale);
}

/* ---------- chart ---------- */

const cctx = els.chartCanvas.getContext("2d");

function chartSize() {
  const cssW = els.chartFrame.clientWidth;
  const cssH = els.chartFrame.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(cssW * dpr));
  const H = Math.max(1, Math.round(cssH * dpr));
  if (els.chartCanvas.width !== W || els.chartCanvas.height !== H) {
    els.chartCanvas.width = W;
    els.chartCanvas.height = H;
  }
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: cssW, h: cssH };
}

function calculateNiceScale(minVal, maxVal, targetTicks = 4, clampZero = true) {
  if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
    return [0, 25, 50, 75, 100];
  }
  if (Math.abs(maxVal - minVal) < 1e-6) {
    minVal = minVal - 2.0;
    maxVal = maxVal + 2.0;
  }

  const span = maxVal - minVal;
  const paddedMax = maxVal + span * 0.15;
  const paddedMin = clampZero && minVal >= 0 ? Math.max(0, minVal - span * 0.08) : minVal - span * 0.08;

  const rawStep = Math.max(1e-6, (paddedMax - paddedMin) / targetTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const err = rawStep / mag;
  const mult = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  const step = mag * mult;

  let firstTick = Math.floor(paddedMin / step) * step;
  if (clampZero && minVal >= 0 && firstTick < 0) {
    firstTick = 0;
  }
  let lastTick = Math.ceil(paddedMax / step) * step;

  const ticks = [];
  for (let v = firstTick; v <= lastTick + step * 0.01; v += step) {
    ticks.push(Number(v.toFixed(6)));
  }
  if (ticks.length > 0 && ticks[ticks.length - 1] < maxVal) {
    ticks.push(Number((ticks[ticks.length - 1] + step).toFixed(6)));
  }
  return ticks;
}

function medianInterval(samples) {
  const ds = [];
  for (let i = 1; i < samples.length; i++) ds.push(samples[i].__t - samples[i - 1].__t);
  if (!ds.length) return 3000;
  ds.sort((a, b) => a - b);
  return ds[Math.floor(ds.length / 2)] || 3000;
}

function chartKeys(samples) {
  const metaUnits = (state.nodes.get(state.selected) || {}).units || {};
  const found = new Set();
  for (const s of samples) {
    for (const [k, v] of Object.entries(s)) {
      if (!["__t", "timestamp", "sequence", "bootId", "rssi", "rssiSourceNodeId", "hops", "ttl", "sender", "destination", "packetPayload", "units"].includes(k) && Number.isFinite(v)) {
        found.add(k);
      }
    }
  }

  const sorted = Array.from(found).sort((a, b) => {
    const priority = (key) => {
      const code = metricCode(key);
      if (code === "T" || key.toLowerCase().includes("temp")) return 0;
      if (code === "H" || key.toLowerCase().includes("hum")) return 1;
      if (code === "P") return 2;
      if (code === "L" || key.toLowerCase().includes("ldr")) return 3;
      return 4;
    };
    const priorityDiff = priority(a) - priority(b);
    if (priorityDiff) return priorityDiff;
    return a.localeCompare(b);
  });

  return sorted.slice(0, 2).map((k, idx) => {
    const code = metricCode(k);
    const defaultUnit = ["L", "T", "H", "P"].includes(code)
      ? metricDefaultUnit(k)
      : metaUnits[k] || metricDefaultUnit(k);

    return {
      key: k,
      label: formatMetricLabel(k),
      rawKey: k,
      unit: defaultUnit,
      decimals: metricDecimals(k),
      axis: idx === 1 ? "right" : "left",
    };
  });
}

const GAP_FACTOR = 3;
let chartRaf = null;
function scheduleChartDraw() {
  if (chartRaf) return;
  chartRaf = requestAnimationFrame(() => {
    chartRaf = null;
    drawChart();
  });
}

function drawChart() {
  const { w, h } = chartSize();
  cctx.clearRect(0, 0, w, h);

  const samples = state.samples.get(state.selected) || [];
  els.chartNode.textContent = state.selected ? nodeLabel(state.selected) : "station";
  els.chartEmpty.style.display = samples.length ? "none" : "flex";
  if (!samples.length) {
    if (els.chartLegend) els.chartLegend.replaceChildren();
    return;
  }

  const pad = { l: 48, r: 48, t: 28, b: 26 };
  const lo = samples[0].__t;
  const hi = samples[samples.length - 1].__t;
  const span = Math.max(3000, hi - lo);
  const pxPerT = (w - pad.l - pad.r) / span;
  const tToX = (t) => pad.l + (t - lo) * pxPerT;
  const med = medianInterval(samples);

  const grid = token("--line", "#2e3237");
  const faint = token("--text-faint", "#8a897f");
  const seriesColors = [
    token("--color-series-temp", "#ffb454"),
    token("--color-series-humidity", "#a8a69b"),
    token("--live", "#6fbf73"),
  ];
  const fontStack = token("--font-mono", "monospace");
  cctx.font = "10px " + fontStack;
  cctx.lineWidth = 1;

  // baseline + x ticks
  cctx.strokeStyle = grid;
  cctx.beginPath();
  cctx.moveTo(pad.l, h - pad.b);
  cctx.lineTo(w - pad.r, h - pad.b);
  cctx.stroke();
  cctx.fillStyle = faint;
  cctx.textAlign = "center";
  const xCount = Math.min(6, Math.max(3, Math.floor((w - pad.l - pad.r) / 90)));
  for (let i = 0; i <= xCount; i++) {
    const t = lo + (span * i) / xCount;
    cctx.fillText(fmtClock(t, span <= 3600000), tToX(t), h - pad.b + 16);
  }

  const keys = chartKeys(samples);

  if (els.chartLegend) {
    els.chartLegend.innerHTML = keys
      .map((m, ki) => {
        const color = seriesColors[ki] || seriesColors[0];
        return `<span class="legend-item"><i class="legend-swatch" style="background:${color}"></i><span>${m.label}${m.unit ? ` (${m.unit})` : ""}</span></span>`;
      })
      .join("");
  }

  keys.forEach((m, ki) => {
    const fs = samples.filter((s) => Number.isFinite(s[m.key]));
    if (!fs.length) return;
    const vals = fs.map((s) => s[m.key]);
    const vMin = Math.min(...vals);
    const vMax = Math.max(...vals);
    const isPercent = m.unit && m.unit.includes("%");
    const ticks = calculateNiceScale(vMin, vMax, 4, isPercent || vMin >= 0);
    const vmin = ticks[0];
    const vmax = ticks[ticks.length - 1];
    const vToY = (v) => h - pad.b - ((v - vmin) / Math.max(1e-9, vmax - vmin)) * (h - pad.t - pad.b);
    const axX = ki === 0 ? pad.l : w - pad.r;

    // Gridlines drawn once using primary metric (ki === 0)
    if (ki === 0) {
      cctx.strokeStyle = token("--line-strong", "#4a4f55");
      ticks.forEach((t) => {
        const y = vToY(t);
        cctx.beginPath();
        cctx.moveTo(pad.l, y);
        cctx.lineTo(w - pad.r, y);
        cctx.stroke();
      });
    }

    // Draw axis ticks: Left axis for Series 0, Right axis only for Series 1 (avoids collisions if >2 metrics)
    if (ki === 0 || ki === 1) {
      cctx.fillStyle = faint;
      cctx.strokeStyle = grid;
      cctx.beginPath();
      cctx.moveTo(axX, pad.t);
      cctx.lineTo(axX, h - pad.b);
      cctx.stroke();
      ticks.forEach((t) => {
        const y = vToY(t);
        cctx.beginPath();
        cctx.moveTo(axX - 2, y);
        cctx.lineTo(axX + 2, y);
        cctx.stroke();
        cctx.textAlign = ki === 0 ? "right" : "left";
        cctx.fillText(String(Number(t.toFixed(1))), ki === 0 ? axX - 6 : axX + 6, y + 3);
      });

      // Draw axis unit clean above the axis line
      cctx.fillStyle = seriesColors[ki] || seriesColors[0];
      cctx.textAlign = ki === 0 ? "right" : "left";
      cctx.fillText(m.unit || "", ki === 0 ? axX - 6 : axX + 6, pad.t - 8);
    }

    // Series line strictly clipped inside plot box with headroom
    cctx.save();
    cctx.beginPath();
    cctx.rect(pad.l, pad.t, w - pad.l - pad.r, h - pad.t - pad.b);
    cctx.clip();

    cctx.strokeStyle = seriesColors[ki] || seriesColors[0];
    cctx.lineWidth = 1.75;
    let pen = false;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const v = s[m.key];
      const prev = samples[i - 1];
      const jumped = prev && s.__t - prev.__t > GAP_FACTOR * med;
      if (!Number.isFinite(v)) {
        pen = false;
        continue;
      }
      const x = tToX(s.__t);
      const y = vToY(v);
      if (!pen || jumped) {
        cctx.beginPath();
        cctx.moveTo(x, y);
        pen = true;
      } else {
        cctx.lineTo(x, y);
        if (i === samples.length - 1) cctx.stroke();
      }
      const nxt = samples[i + 1];
      const nxtMissing = !nxt || !Number.isFinite(nxt[m.key]) || (nxt && nxt.__t - s.__t > GAP_FACTOR * med);
      if (pen && nxtMissing) {
        cctx.stroke();
        pen = false;
      }
    }
    cctx.lineWidth = 1;
    cctx.restore();
  });

  if (!keys.length) {
    cctx.fillStyle = faint;
    cctx.textAlign = "center";
    cctx.fillText("no numeric readings in this window", (w - pad.l - pad.r) / 2 + pad.l, h / 2);
  }
}

function renderChartTable(samples) {
  const thead = els.chartTable.querySelector("thead tr");
  const tbody = els.chartTable.querySelector("tbody");
  const keys = chartKeys(samples);

  if (thead) {
    let headHtml = '<th scope="col">Time</th>';
    if (keys.length) {
      headHtml += keys.map((m) => `<th scope="col">${m.label}${m.unit ? ` (${m.unit})` : ""}</th>`).join("");
    } else {
      headHtml += '<th scope="col">Temperature</th><th scope="col">Humidity</th>';
    }
    thead.innerHTML = headHtml;
  }

  const rows = samples.slice(-10).reverse().map((s) => {
    let cellsHtml = `<td>${fmtClock(s.timestamp)}</td>`;
    if (keys.length) {
      cellsHtml += keys
        .map((m) => {
          const v = s[m.key];
          return `<td>${Number.isFinite(v) ? v.toFixed(m.decimals !== undefined ? m.decimals : 1) + (m.unit ? ` ${m.unit}` : "") : "not reporting"}</td>`;
        })
        .join("");
    } else {
      const t = s.temperature;
      const hu = s.humidity;
      cellsHtml += `<td>${Number.isFinite(t) ? t.toFixed(1) + " °C" : "not reporting"}</td><td>${Number.isFinite(hu) ? Math.round(hu).toFixed(0) + " % RH" : "not reporting"}</td>`;
    }
    return `<tr>${cellsHtml}</tr>`;
  });
  tbody.innerHTML = rows.join("");
}

const resizeObserver = new ResizeObserver(() => scheduleChartDraw());
resizeObserver.observe(els.chartFrame);

/* ---------- cross-node measurement comparison ---------- */

const compareContext = els.compareCanvas.getContext("2d");
const COMPARE_PALETTE = [
  "--color-series-temp",
  "--color-series-humidity",
  "--color-compare-3",
  "--color-compare-4",
  "--color-compare-5",
  "--color-compare-6",
  "--color-compare-7",
  "--color-compare-8",
];
const NON_MEASUREMENT_KEYS = new Set([
  "__t", "timestamp", "sequence", "bootId", "rssi", "rssiSourceNodeId", "hops",
  "ttl", "sender", "destination", "packetPayload", "units",
]);
let compareRaf = null;

function comparisonMetrics() {
  const keys = new Set();
  for (const samples of state.samples.values()) {
    for (const sample of samples) {
      for (const [key, value] of Object.entries(sample)) {
        if (!NON_MEASUREMENT_KEYS.has(key) && Number.isFinite(value)) keys.add(key);
      }
    }
  }
  return [...keys].sort((a, b) => {
    const priority = (key) => {
      const code = metricCode(key);
      if (code === "T" || key.toLowerCase().includes("temp")) return 0;
      if (code === "H" || key.toLowerCase().includes("hum")) return 1;
      if (code === "P" || key.toLowerCase().includes("press")) return 2;
      if (code === "L" || key.toLowerCase().includes("ldr")) return 3;
      return 4;
    };
    return priority(a) - priority(b) || a.localeCompare(b);
  });
}

function comparisonUnit(key) {
  for (const [nodeId, samples] of state.samples) {
    if (samples.some((sample) => Number.isFinite(sample[key]))) {
      const sampleUnits = samples[samples.length - 1]?.units || {};
      const nodeUnits = state.nodes.get(nodeId)?.units || {};
      const code = metricCode(key);
      return ["L", "T", "H", "P"].includes(code)
        ? metricDefaultUnit(key)
        : sampleUnits[key] || nodeUnits[key] || metricDefaultUnit(key);
    }
  }
  return metricDefaultUnit(key);
}

function renderComparisonControls() {
  const keys = comparisonMetrics();
  const previous = state.compareMetric || els.compareMeasurement.value;
  const preferred = keys.find((key) => {
    const code = metricCode(key);
    return code === "T" || key.toLowerCase().includes("temp");
  });
  const selected = keys.includes(previous) ? previous : preferred || keys[0] || "";
  state.compareMetric = selected || null;

  const options = document.createDocumentFragment();
  if (!keys.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "WAITING FOR MEASUREMENTS";
    options.appendChild(option);
  } else {
    for (const key of keys) {
      const option = document.createElement("option");
      option.value = key;
      const unit = comparisonUnit(key);
      option.textContent = `${formatMetricLabel(key)}${unit ? ` (${unit})` : ""}`;
      options.appendChild(option);
    }
  }
  els.compareMeasurement.replaceChildren(options);
  els.compareMeasurement.value = selected;
  els.compareMeasurement.disabled = !keys.length;
}

function scheduleComparisonDraw() {
  if (compareRaf) return;
  compareRaf = requestAnimationFrame(() => {
    compareRaf = null;
    drawComparisonChart();
  });
}

function drawComparisonChart() {
  const canvas = els.compareCanvas;
  const frame = els.compareChartFrame;
  const width = frame.clientWidth;
  const height = frame.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  compareContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  compareContext.clearRect(0, 0, width, height);

  const key = els.compareMeasurement.value;
  const nodes = [...state.nodes.keys()].sort((a, b) => a.localeCompare(b));
  const series = nodes.map((nodeId, index) => ({
    nodeId,
    color: token(COMPARE_PALETTE[index % COMPARE_PALETTE.length], "#a8a69b"),
    samples: (state.samples.get(nodeId) || []).filter(
      (sample) => Number.isFinite(sample.__t) && Number.isFinite(sample[key])
    ),
  })).filter((item) => item.samples.length);
  const allSamples = series.flatMap((item) => item.samples);

  if (!allSamples.length) {
    els.compareEmpty.textContent = nodes.length
      ? (key ? "no node has reported this measurement yet" : "waiting for measurement history")
      : "no nodes are reporting";
    els.compareEmpty.style.display = "flex";
    els.compareLegend.replaceChildren();
    canvas.setAttribute("aria-label", "No data available for the selected measurement");
    return;
  }

  els.compareEmpty.style.display = "none";
  const lo = Math.min(...allSamples.map((sample) => sample.__t));
  const hi = Math.max(...allSamples.map((sample) => sample.__t));
  const span = Math.max(3000, hi - lo);
  const values = allSamples.map((sample) => sample[key]);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const unit = comparisonUnit(key);
  const ticks = calculateNiceScale(minValue, maxValue, 5, Boolean(unit && unit.includes("%")) || minValue >= 0);
  const minY = ticks[0];
  const maxY = ticks[ticks.length - 1];
  const pad = { l: 58, r: 16, t: 22, b: 32 };
  const plotWidth = Math.max(1, width - pad.l - pad.r);
  const plotHeight = Math.max(1, height - pad.t - pad.b);
  const x = (timestamp) => pad.l + ((timestamp - lo) / span) * plotWidth;
  const y = (value) => height - pad.b - ((value - minY) / Math.max(1e-9, maxY - minY)) * plotHeight;
  const grid = token("--line", "#2e3237");
  const faint = token("--text-faint", "#8a897f");
  const font = token("--font-mono", "monospace");

  compareContext.font = `10px ${font}`;
  compareContext.lineWidth = 1;
  compareContext.strokeStyle = grid;
  compareContext.fillStyle = faint;
  compareContext.textAlign = "right";
  ticks.forEach((tick) => {
    const py = y(tick);
    compareContext.beginPath();
    compareContext.moveTo(pad.l, py);
    compareContext.lineTo(width - pad.r, py);
    compareContext.stroke();
    compareContext.fillText(String(Number(tick.toPrecision(4))), pad.l - 7, py + 3);
  });

  compareContext.textAlign = "center";
  const xCount = Math.min(6, Math.max(3, Math.floor(plotWidth / 100)));
  for (let i = 0; i <= xCount; i++) {
    const timestamp = lo + (span * i) / xCount;
    const px = x(timestamp);
    compareContext.fillText(fmtClock(timestamp, span <= 3600000), px, height - 9);
  }
  compareContext.textAlign = "left";
  compareContext.fillText(unit || "", pad.l, 12);

  for (const item of series) {
    const med = medianInterval(item.samples);
    compareContext.save();
    compareContext.beginPath();
    compareContext.rect(pad.l, pad.t, plotWidth, plotHeight);
    compareContext.clip();
    compareContext.strokeStyle = item.color;
    compareContext.lineWidth = 1.8;
    let pen = false;
    for (let index = 0; index < item.samples.length; index++) {
      const sample = item.samples[index];
      const previous = item.samples[index - 1];
      const gap = previous && sample.__t - previous.__t > GAP_FACTOR * med;
      if (!pen || gap) {
        compareContext.beginPath();
        compareContext.moveTo(x(sample.__t), y(sample[key]));
        pen = true;
      } else {
        compareContext.lineTo(x(sample.__t), y(sample[key]));
      }
      compareContext.stroke();
    }
    compareContext.restore();
  }

  const legend = document.createDocumentFragment();
  for (const item of series) {
    const entry = document.createElement("span");
    entry.className = "legend-item";
    const swatch = document.createElement("i");
    swatch.className = "legend-swatch";
    swatch.style.backgroundColor = item.color;
    const label = document.createElement("span");
    label.textContent = nodeLabel(item.nodeId);
    entry.append(swatch, label);
    legend.appendChild(entry);
  }
  els.compareLegend.replaceChildren(legend);
  canvas.setAttribute(
    "aria-label",
    `${formatMetricLabel(key)} comparison across ${series.length} nodes`
  );
}

async function loadComparisonHistories() {
  renderComparisonControls();
  const missing = [...state.nodes.keys()].filter(
    (nodeId) => !state.historyLoaded.has(nodeId) && !state.historyLoading.has(nodeId)
  );
  await Promise.all(missing.map((nodeId) => loadHistory(nodeId)));
  renderComparisonControls();
  scheduleComparisonDraw();
}

function setActiveView(view) {
  state.activeView = view;
  const compare = view === "compare";
  els.overviewTab.setAttribute("aria-pressed", String(!compare));
  els.compareTab.setAttribute("aria-pressed", String(compare));
  els.overviewView.hidden = compare;
  els.compareView.hidden = !compare;
  if (compare) {
    loadComparisonHistories();
    scheduleComparisonDraw();
  } else {
    scheduleChartDraw();
  }
}

function initComparisonView() {
  els.overviewTab.addEventListener("click", () => setActiveView("overview"));
  els.compareTab.addEventListener("click", () => setActiveView("compare"));
  els.compareMeasurement.addEventListener("change", () => {
    state.compareMetric = els.compareMeasurement.value || null;
    scheduleComparisonDraw();
  });
  const compareResizeObserver = new ResizeObserver(scheduleComparisonDraw);
  compareResizeObserver.observe(els.compareChartFrame);
}

/* ---------- automated insights ---------- */

async function loadInsights(nodeId) {
  if (!nodeId) {
    els.insightsNode.textContent = "station";
    els.insightsUpdatedAt.textContent = "—";
    els.insightsContent.replaceChildren();
    const p = document.createElement("p");
    p.className = "empty-note";
    p.textContent = "no station selected";
    els.insightsContent.appendChild(p);
    return;
  }

  const isNodeChange = els.insightsNode.dataset.nodeId !== nodeId;
  els.insightsNode.dataset.nodeId = nodeId;
  els.insightsNode.textContent = nodeLabel(nodeId);
  els.insightsUpdatedAt.textContent = "updating…";
  if (isNodeChange) {
    els.insightsContent.replaceChildren();
  }
  let parsed;
  try {
    const res = await fetch(`/nodes/${encodeURIComponent(nodeId)}/insights`);
    if (!res.ok) throw new Error(String(res.status));
    parsed = await res.json();
  } catch {
    if (state.selected !== nodeId) return;
    els.insightsUpdatedAt.textContent = "unavailable";
    const note = document.createElement("p");
    note.className = "empty-note";
    note.textContent = "Insights temporarily unavailable.";
    els.insightsContent.replaceChildren(note);
    return;
  }

  if (state.selected !== nodeId) return;

  els.insightsUpdatedAt.textContent = fmtClock(parsed.generatedAt || new Date().toISOString());

  const count = Number(parsed.sampleCount) || 0;
  const insights = Array.isArray(parsed.insights) ? parsed.insights : [];

  // Check if there are any numeric sensor samples in local history
  const historySamples = state.samples.get(nodeId) || [];
  let hasNumericSensorSample = false;
  for (const s of historySamples) {
    for (const [k, v] of Object.entries(s)) {
      if (!["__t", "timestamp", "sequence", "bootId", "rssi", "rssiSourceNodeId", "hops", "units"].includes(k) && Number.isFinite(v)) {
        hasNumericSensorSample = true;
        break;
      }
    }
    if (hasNumericSensorSample) break;
  }

  if (count === 0 || (!hasNumericSensorSample && count >= 20 && insights.length === 0)) {
    const note = document.createElement("p");
    note.className = "empty-note";
    note.textContent = "No numeric sensor history available.";
    els.insightsContent.replaceChildren(note);
    return;
  }

  if (count < 20) {
    const existingNote = els.insightsContent.querySelector(".empty-note");
    if (existingNote) {
      existingNote.textContent = `Collecting baseline: ${count}/20 valid samples.`;
    } else {
      const note = document.createElement("p");
      note.className = "empty-note";
      note.textContent = `Collecting baseline: ${count}/20 valid samples.`;
      els.insightsContent.replaceChildren(note);
    }
    return;
  }

  if (insights.length === 0) {
    const note = document.createElement("p");
    note.className = "empty-note";
    note.textContent = "All metrics within normal range; trends steady.";
    els.insightsContent.replaceChildren(note);
    return;
  }

  els.insightsContent.replaceChildren();
  for (const item of insights) {
    const row = document.createElement("div");
    row.className = "insight-row";
    row.dataset.kind = item.kind || "trend";

    const tag = document.createElement("span");
    tag.className = "insight-tag";
    tag.textContent = (item.kind || "insight").toUpperCase();

    const msg = document.createElement("span");
    msg.className = "insight-text";
    // Crucial requirement: insert returned message text with textContent, not innerHTML
    const metricLabel = item.metric ? formatMetricLabel(item.metric) : "";
    const metricUnit = item.metric ? metricDefaultUnit(item.metric) : "";
    const displayLabel = metricUnit ? `${metricLabel} (${metricUnit})` : metricLabel;
    msg.textContent = item.metric && item.message
      ? item.message.split(item.metric).join(displayLabel)
      : item.message || "";

    row.appendChild(tag);
    row.appendChild(msg);
    els.insightsContent.appendChild(row);
  }
}

let insightDebounceTimer = null;
function scheduleInsightsUpdate(nodeId) {
  if (state.selected !== nodeId) return;
  clearTimeout(insightDebounceTimer);
  insightDebounceTimer = setTimeout(() => {
    if (state.selected === nodeId) {
      loadInsights(nodeId);
    }
  }, 1000);
}

/* ---------- stations switching + history ---------- */

function applyStation() {
  renderMetrics();
  const cached = state.samples.get(state.selected) || [];
  scheduleChartDraw();
  renderChartTable(cached);

  const { node, last } = nodeSnapshot(state.selected);
  const seq = (node && node.sequence !== undefined && node.sequence !== null)
    ? node.sequence
    : (last && last.sequence);
  els.chartSeq.textContent = Number.isInteger(seq) ? `SEQ ${seq}` : "";
}

function selectStation(id) {
  if (state.selected === id) return;
  state.selected = id;
  if (els.chatContextNode) {
    els.chatContextNode.textContent =
      state.chatScope === "all" || !id ? "ALL STATIONS" : nodeLabel(id);
  }
  renderRoster();
  els.insightsContent.replaceChildren();
  els.insightsNode.dataset.nodeId = id;
  els.insightsNode.textContent = nodeLabel(id);
  els.insightsUpdatedAt.textContent = "updating…";

  applyStation();
  const cached = state.samples.get(id);
  if (!cached || cached.length < 2) loadHistory(id);
  loadInsights(id);
  pushLog("info", id, "selected");
}

async function loadHistory(nodeId) {
  if (state.historyLoaded.has(nodeId) || state.historyLoading.has(nodeId)) return;
  state.historyLoading.add(nodeId);
  let parsed;
  try {
    const res = await fetch(`/nodes/${encodeURIComponent(nodeId)}/history?limit=200`);
    if (!res.ok) throw new Error(String(res.status));
    parsed = await res.json();
  } catch {
    pushLog("dropped", nodeId, "history request failed");
    return;
  } finally {
    state.historyLoading.delete(nodeId);
  }
  const raw = Array.isArray(parsed && parsed.samples) ? parsed.samples : [];
  const samples = raw
    .map((s) => {
      const obj = {
        __t: Date.parse(s.timestamp),
        timestamp: s.timestamp,
        sequence: s.sequence,
        bootId: s.bootId,
        rssi: s.rssi,
        rssiSourceNodeId: s.rssiSourceNodeId,
        hops: s.hops,
        units: s.units,
      };
      for (const [k, v] of Object.entries(s)) {
        if (!["__t", "timestamp", "sequence", "bootId", "rssi", "rssiSourceNodeId", "hops", "ttl", "sender", "destination", "packetPayload", "units"].includes(k)) {
          const num = Number(v);
          if (Number.isFinite(num)) obj[k] = num;
        }
      }
      return obj;
    })
    .filter((s) => Number.isFinite(s.__t))
    .concat(state.samples.get(nodeId) || []);
  const mergedSamples = [...new Map(samples.map((sample) => [sample.__t, sample])).values()]
    .sort((a, b) => a.__t - b.__t)
    .slice(-MAX_SAMPLES);

  state.samples.set(nodeId, mergedSamples);
  state.historyLoaded.add(nodeId);
  renderComparisonControls();
  if (state.activeView === "compare") scheduleComparisonDraw();
  if (state.selected === nodeId) {
    applyStation();
    loadInsights(nodeId);
  }
}

async function refreshNodes() {
  let parsed;
  try {
    const res = await fetch("/nodes");
    if (!res.ok) throw new Error(String(res.status));
    parsed = await res.json();
  } catch {
    return;
  }
  const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  nodes.forEach((n) => upsertNode(n));
  renderRoster();
  renderHealth();
  if (!state.selected && nodes.length) {
    state.selected = nodes[0].nodeId;
    applyStation();
    loadHistory(state.selected);
    loadInsights(state.selected);
  } else if (state.selected && state.nodes.has(state.selected)) {
    renderMetrics();
  }
  renderComparisonControls();
  if (state.activeView === "compare") loadComparisonHistories();
}

async function refreshHealth() {
  try {
    const res = await fetch("/health");
    state.health = await res.json();
  } catch {
    return;
  }
  renderStatus();
}

function refreshNow() {
  refreshHealth();
  refreshNodes();
}

/* ---------- websocket ---------- */

let retryTimer = null;

function connectSocket() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}/live`);

  socket.addEventListener("open", () => {
    state.wsOpen = true;
    renderStatus();
    pushLog("info", "system", "dashboard stream connected");
    refreshNow();
  });

  socket.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "status" && typeof msg.gatewayConnected === "boolean") {
      state.health = { ...(state.health || {}), gatewayConnected: msg.gatewayConnected };
      renderStatus();
      return;
    }
    if (msg.type === "telemetry" && msg.nodeId) onTelemetry(msg);
  });

  socket.addEventListener("close", () => {
    state.wsOpen = false;
    renderStatus();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connectSocket, 2000);
  });
}

function onTelemetry(msg) {
  upsertNode({
    nodeId: msg.nodeId,
    timestamp: msg.timestamp,
    sequence: msg.sequence,
    payload: msg.payload,
    units: msg.units,
    rssi: msg.rssi,
    rssiSourceNodeId: msg.rssiSourceNodeId,
    hops: msg.hops,
    sender: msg.sender,
    destination: msg.destination,
    ttl: msg.ttl,
    packetPayload: msg.packetPayload,
    bootId: msg.bootId,
    batteryLevel: msg.batteryLevel,
    role: msg.role,
  });

  const arr = state.samples.get(msg.nodeId) || [];
  const s = {
    __t: Date.parse(msg.timestamp),
    timestamp: msg.timestamp,
    sequence: msg.sequence,
    bootId: msg.bootId,
    rssi: msg.rssi,
    rssiSourceNodeId: msg.rssiSourceNodeId,
    hops: msg.hops,
    ttl: msg.ttl,
    sender: msg.sender,
    destination: msg.destination,
    packetPayload: msg.packetPayload,
    units: msg.units,
  };
  for (const [k, v] of Object.entries(msg.payload || {})) {
    const n = Number(v);
    if (Number.isFinite(n)) s[k] = n;
  }
  arr.push(s);
  if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES);
  state.samples.set(msg.nodeId, arr);

  renderComparisonControls();
  if (state.activeView === "compare") {
    scheduleComparisonDraw();
    if (!state.historyLoaded.has(msg.nodeId) && !state.historyLoading.has(msg.nodeId)) {
      loadHistory(msg.nodeId);
    }
  }

  renderRoster();
  renderHealth();
  if (!state.selected) {
    state.selected = msg.nodeId;
    if (els.chatContextNode) els.chatContextNode.textContent = state.selected;
    applyStation();
    loadInsights(state.selected);
  } else if (msg.nodeId === state.selected) {
    applyStation();
    els.updatedAt.textContent = `${fmtClock(msg.timestamp)} · ${ageText(ageSeconds(msg.timestamp))}`;
    scheduleInsightsUpdate(msg.nodeId);
  } else {
    renderMetrics();
  }

  const seqPrefix = Number.isInteger(msg.sequence) ? `SEQ ${msg.sequence} · ` : "";
  const bootPrefix = msg.bootId ? `[boot ${msg.bootId}] · ` : "";
  const readingsSummary =
    Object.entries(msg.payload || {})
      .map(([k, v]) => {
        const code = metricCode(k);
        const unit = ["L", "T", "H", "P"].includes(code)
          ? metricDefaultUnit(k)
          : (msg.units && msg.units[k]) || metricDefaultUnit(k);
        return `${formatMetricLabel(k)} ${Number.isFinite(Number(v)) ? Number(v) : v}${unit ? ` ${unit}` : ""}`;
      })
      .join(" · ");
  const packetSummary = msg.packetPayload !== undefined
    ? `${msg.sender || msg.nodeId} → ${msg.destination || "—"} · TTL ${msg.ttl ?? "—"} · ${msg.hops ?? "—"} hops · payload: ${msg.packetPayload}`
    : "";
  const summary = [readingsSummary, packetSummary].filter(Boolean).join(" · ") || "telemetry received";

  pushLog("info", msg.nodeId, `${seqPrefix}${bootPrefix}${summary}`);
}

/* periodic refresh */
setInterval(() => {
  renderRoster();
  renderMetrics();
}, 1000);
setInterval(refreshHealth, 2000);
setInterval(refreshNodes, 5000);
setInterval(() => {
  if (state.selected) {
    loadInsights(state.selected);
  }
}, 10000);


/* ---------- ai assistant chat ---------- */

function appendChatMessage(role, text) {
  if (!els.chatMessages) return;
  const msg = document.createElement("div");
  msg.className = `chat-msg chat-msg-${role}`;

  const header = document.createElement("div");
  header.className = "chat-msg-header";

  const roleLabel = document.createElement("span");
  roleLabel.className = "chat-role";
  roleLabel.textContent = role === "user" ? "[USER]" : "[AI]";
  header.appendChild(roleLabel);

  if (role === "assistant" && text && !text.includes("thinking…")) {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy-btn";
    copyBtn.textContent = "COPY";
    copyBtn.title = "Copy message to clipboard";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = "COPIED";
        setTimeout(() => { copyBtn.textContent = "COPY"; }, 1500);
      });
    });
    header.appendChild(copyBtn);
  }

  const textSpan = document.createElement("div");
  textSpan.className = "chat-text";
  textSpan.textContent = text;

  msg.appendChild(header);
  msg.appendChild(textSpan);
  els.chatMessages.appendChild(msg);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  return msg;
}

async function checkAiStatus() {
  try {
    const res = await fetch("/api/ai/status");
    if (!res.ok) return;
    const data = await res.json();
    if (els.aiModelTag) {
      if (data.configured && data.model) {
        els.aiModelTag.textContent = data.model.toUpperCase();
        els.aiModelTag.dataset.state = "live";
      } else {
        els.aiModelTag.textContent = "OFFLINE";
        els.aiModelTag.dataset.state = "stale";
      }
    }
  } catch {
    if (els.aiModelTag) {
      els.aiModelTag.textContent = "OFFLINE";
      els.aiModelTag.dataset.state = "stale";
    }
  }
}

async function sendChatMessage(promptText) {
  const text = (promptText !== undefined ? promptText : els.chatInput?.value || "").trim();
  if (!text || state.chatLoading) return;

  if (els.chatInput) els.chatInput.value = "";
  state.chatLoading = true;
  if (els.chatSendBtn) els.chatSendBtn.disabled = true;
  if (els.chatInput) els.chatInput.disabled = true;

  appendChatMessage("user", text);
  state.chatHistory.push({ role: "user", content: text });
  persistChatHistory();

  const pendingMsg = appendChatMessage("assistant", "thinking…");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        nodeId: state.chatScope === "all" ? null : (state.selected || null),
        history: state.chatHistory.slice(0, -1).slice(-8),
      }),
    });

    const data = await res.json();
    if (pendingMsg && pendingMsg.isConnected) pendingMsg.remove();

    const reply = data.reply || (data.error ? "Error: " + data.reply : "No response from AI.");
    appendChatMessage("assistant", reply);
    state.chatHistory.push({ role: "assistant", content: reply });
    persistChatHistory();

    if (data.model && els.aiModelTag) {
      els.aiModelTag.textContent = data.model.toUpperCase();
      els.aiModelTag.dataset.state = "live";
    }
  } catch (err) {
    if (pendingMsg && pendingMsg.isConnected) pendingMsg.remove();
    appendChatMessage("assistant", "Network error communicating with AI server.");
  } finally {
    state.chatLoading = false;
    if (els.chatSendBtn) els.chatSendBtn.disabled = false;
    if (els.chatInput) {
      els.chatInput.disabled = false;
      els.chatInput.focus();
    }
  }
}

const CHAT_STORE = "espMeshChatHistory";

/* The expanded tab shares this transcript, so the two views stay in sync. */
function persistChatHistory() {
  try {
    localStorage.setItem(CHAT_STORE, JSON.stringify(state.chatHistory.slice(-40)));
  } catch {
    /* storage blocked: chat still works, the pop-out just starts empty */
  }
}

function openExpandedChat() {
  const node = state.chatScope === "all" ? "" : (state.selected || "");
  const win = window.open(`/static/chat.html?node=${encodeURIComponent(node)}`, "mesh-ai-chat");
  if (win) win.focus();
}

const CHAT_VISIBLE_KEY = "espMeshChatVisible";

/* Collapse the sidebar to give the charts the full width; the floating AI button brings it back. */
function setChatVisible(visible, options = {}) {
  if (!els.chatSidebar) return;
  els.chatSidebar.classList.toggle("is-collapsed", !visible);
  els.chatSidebar.setAttribute("aria-hidden", String(!visible));
  if (els.chatOpenBtn) {
    els.chatOpenBtn.dataset.visible = String(!visible);
    els.chatOpenBtn.setAttribute("aria-expanded", String(visible));
  }
  try {
    localStorage.setItem(CHAT_VISIBLE_KEY, visible ? "1" : "0");
  } catch {
    /* storage blocked: the toggle still works for this session */
  }
  if (visible) {
    if (els.chatMessages) els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
    if (options.focus && els.chatInput) els.chatInput.focus();
  }
}

function initChatEvents() {
  if (els.chatForm) {
    els.chatForm.addEventListener("submit", (e) => {
      e.preventDefault();
      sendChatMessage();
    });
  }

  if (els.chatExpandBtn) {
    els.chatExpandBtn.addEventListener("click", openExpandedChat);
  }

  let chatVisible = true;
  try {
    chatVisible = localStorage.getItem(CHAT_VISIBLE_KEY) !== "0";
  } catch {
    /* ignore */
  }
  setChatVisible(chatVisible);

  if (els.chatCloseBtn) {
    els.chatCloseBtn.addEventListener("click", () => setChatVisible(false));
  }
  if (els.chatOpenBtn) {
    els.chatOpenBtn.addEventListener("click", () => setChatVisible(true, { focus: true }));
  }

  if (els.chatClearBtn) {
    els.chatClearBtn.addEventListener("click", () => {
      state.chatHistory = [];
      try {
        localStorage.removeItem(CHAT_STORE);
      } catch {
        /* ignore */
      }
      if (els.chatMessages) {
        els.chatMessages.replaceChildren();
        appendChatMessage("assistant", "Chat history cleared. Ready for your questions.");
      }
    });
  }
  if (els.chatContextNode) {
    els.chatContextNode.title = "Click to toggle between active station and all-stations mesh summary";
    els.chatContextNode.addEventListener("click", () => {
      state.chatScope = state.chatScope === "all" ? "selected" : "all";
      els.chatContextNode.textContent =
        state.chatScope === "all" || !state.selected ? "ALL STATIONS" : nodeLabel(state.selected);
      appendChatMessage(
        "assistant",
        state.chatScope === "all"
          ? "Context switched to ALL STATIONS (entire mesh network)."
          : `Context switched to ${state.selected || "active station"}.`
      );
    });
  }

  document.querySelectorAll(".quick-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const p = btn.getAttribute("data-prompt");
      if (p) sendChatMessage(p);
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !els.chatSidebar) return;
    if (els.chatSidebar.classList.contains("is-collapsed")) return;
    if (!els.chatSidebar.contains(document.activeElement)) return;
    setChatVisible(false);
  });

  checkAiStatus();
}

/* ---------- boot ---------- */

refreshHealth().then(refreshNodes).then(() => {
  applyStation();
  drawChart();
  initComparisonView();
  initMeshControls();
  initChatEvents();
  connectSocket();
});
