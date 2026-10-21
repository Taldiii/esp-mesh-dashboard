/* Full-page AI chat. Same backend contract as the dashboard sidebar:
   POST /api/chat {message, nodeId, history} -> {reply, model, configured, error?}. */

const CHAT_STORE = "espMeshChatHistory";

const els = {
  modelTag: document.getElementById("ai-model-tag"),
  scope: document.getElementById("scope-select"),
  clearBtn: document.getElementById("chat-clear-btn"),
  messages: document.getElementById("chat-messages"),
  form: document.getElementById("chat-form"),
  input: document.getElementById("chat-input"),
  sendBtn: document.getElementById("chat-send-btn"),
};

const state = {
  history: [],
  loading: false,
  scope: "all",
};

const nodeNames = new Map();

/* ---------- transcript ---------- */

function persist() {
  try {
    localStorage.setItem(CHAT_STORE, JSON.stringify(state.history.slice(-40)));
  } catch {
    /* storage blocked — the tab still works, it just will not sync back */
  }
}

function restore() {
  try {
    const raw = localStorage.getItem(CHAT_STORE);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    state.history = parsed.filter(
      (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
    );
  } catch {
    state.history = [];
  }
}

function appendMessage(role, text) {
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
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = "COPIED";
        setTimeout(() => {
          copyBtn.textContent = "COPY";
        }, 1500);
      });
    });
    header.appendChild(copyBtn);
  }

  const body = document.createElement("div");
  body.className = "chat-text";
  body.textContent = text;

  msg.appendChild(header);
  msg.appendChild(body);
  els.messages.appendChild(msg);
  els.messages.scrollTop = els.messages.scrollHeight;
  return msg;
}

function renderTranscript() {
  els.messages.replaceChildren();
  if (state.history.length === 0) {
    appendMessage(
      "assistant",
      "Ready. Ask about network health, hop paths, signal strength, or weather physics (e.g. dew point and rain likelihood)."
    );
    return;
  }
  state.history.forEach((m) => appendMessage(m.role, m.content));
}

/* ---------- data ---------- */

async function loadStatus() {
  try {
    const res = await fetch("/api/ai/status");
    if (!res.ok) return;
    const data = await res.json();
    if (!els.modelTag) return;
    if (data.configured && data.model) {
      els.modelTag.textContent = data.model.toUpperCase();
      els.modelTag.dataset.state = "live";
    } else {
      els.modelTag.textContent = "OFFLINE";
      els.modelTag.dataset.state = "stale";
    }
  } catch {
    if (els.modelTag) {
      els.modelTag.textContent = "OFFLINE";
      els.modelTag.dataset.state = "stale";
    }
  }
}

async function loadNodes() {
  const wanted = new URLSearchParams(location.search).get("node") || "";
  try {
    const res = await fetch("/nodes");
    if (!res.ok) return;
    const data = await res.json();
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];
    nodes.forEach((node) => {
      const option = document.createElement("option");
      option.value = node.nodeId;
      option.textContent = node.displayName || node.nodeId;
      nodeNames.set(node.nodeId, node.displayName || node.nodeId);
      els.scope.appendChild(option);
    });
    if (wanted && nodes.some((n) => n.nodeId === wanted)) {
      els.scope.value = wanted;
      state.scope = wanted;
    }
  } catch {
    /* keep "ALL STATIONS" */
  }
}

/* ---------- chat ---------- */

async function sendMessage(promptText) {
  const text = (promptText !== undefined ? promptText : els.input.value || "").trim();
  if (!text || state.loading) return;

  els.input.value = "";
  state.loading = true;
  els.sendBtn.disabled = true;
  els.input.disabled = true;

  appendMessage("user", text);
  state.history.push({ role: "user", content: text });
  persist();

  const pending = appendMessage("assistant", "thinking…");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        nodeId: state.scope === "all" ? null : state.scope,
        history: state.history.slice(0, -1).slice(-8),
      }),
    });

    const data = await res.json();
    if (pending && pending.isConnected) pending.remove();

    const reply = data.reply || "No response from AI.";
    appendMessage("assistant", reply);
    state.history.push({ role: "assistant", content: reply });
    persist();

    if (data.model && els.modelTag) {
      els.modelTag.textContent = data.model.toUpperCase();
      els.modelTag.dataset.state = "live";
    }
  } catch {
    if (pending && pending.isConnected) pending.remove();
    appendMessage("assistant", "Network error communicating with AI server.");
  } finally {
    state.loading = false;
    els.sendBtn.disabled = false;
    els.input.disabled = false;
    els.input.focus();
  }
}

/* ---------- events ---------- */

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});

els.scope.addEventListener("change", () => {
  state.scope = els.scope.value;
  appendMessage(
    "assistant",
    state.scope === "all"
      ? "Context switched to ALL STATIONS (entire mesh network)."
      : `Context switched to ${nodeNames.get(state.scope) || state.scope}.`
  );
});

els.clearBtn.addEventListener("click", () => {
  state.history = [];
  try {
    localStorage.removeItem(CHAT_STORE);
  } catch {
    /* ignore */
  }
  renderTranscript();
});

document.querySelectorAll(".quick-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const prompt = btn.getAttribute("data-prompt");
    if (prompt) sendMessage(prompt);
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.activeElement !== els.input) window.close();
});

/* ---------- boot ---------- */

restore();
renderTranscript();
loadStatus();
loadNodes();
els.input.focus();
