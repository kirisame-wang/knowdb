import Anthropic from "@anthropic-ai/sdk";
import { KNOWDB_TOOLS } from "./agent/tools.js";
import { runAgentTurn } from "./agent/loop.js";
import { search, expand, siblings, parent, splitId, compareChunkIds } from "./db_query.js";
import { BrowserGapSink } from "./gaps.js";
import { BrowserTraceCollector, BrowserTraceSink } from "./traces.js";
import { mount as mountAuditTrailViz } from "./audit-trail-viz.js";
import { MODEL, MAX_OUTPUT_TOKENS } from "./constants.js";
import { SessionContext, truncateOutput } from "./utils.js";
import type { SearchIndex, Manifest } from "./types.js";

// ── State ─────────────────────────────────────────────────────────────────────

let searchIndex: SearchIndex = {};
let manifest: Manifest = {};
let selectedId: string | null = null;
// Non-null while a turn runs; the Send button doubles as Stop and aborts it.
let activeAbort: AbortController | null = null;
const chatHistory: Anthropic.Messages.MessageParam[] = [];
// One session for the page load: both sinks share it so trace x gap join
// on session_id holds within a conversation.
const session = new SessionContext();
const gapSink = new BrowserGapSink(window.localStorage, "knowdb-gaps", session);
const traceSink = new BrowserTraceSink(window.localStorage);
const traceCollector = new BrowserTraceCollector(session);

// ── DOM helpers ───────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// ── Init ──────────────────────────────────────────────────────────────────────

// Mount the trajectory viz against the same trace collector that feeds the
// sink, rendering into the footprint root below the doc tree. mount() returns a
// teardown; the demo lives for the page lifetime, so it is discarded.
function setupAuditTrailViz() {
  // onSelect = selectChunk: a footprint click (or navigation) opens the preview.
  mountAuditTrailViz(traceCollector, el("knowdb-footprint-root"), selectChunk, MODEL.pricing);
}

async function init() {
  try {
    const [idx, man] = await Promise.all([
      fetch("db/_search_index.json").then((r) => (r.ok ? r.json() : {})),
      fetch("db/_manifest.json").then((r) => (r.ok ? r.json() : {})),
    ]);
    searchIndex = idx as SearchIndex;
    manifest = man as typeof manifest;
    renderDocTree();
  } catch {
    el("doc-tree").innerHTML =
      '<div class="status-text">No database found. Run: npm run ingest &lt;file.md&gt;</div>';
  }

  setupSearch();
  setupNav();
  setupApiKey();
  setupChat();
  setupGapExport();
  setupTraceExport();
  setupAuditTrailViz();
}

// ── Left Panel: Doc Tree ──────────────────────────────────────────────────────

function renderDocTree() {
  const container = el("doc-tree");
  const docIds = Object.keys(manifest);

  if (docIds.length === 0) {
    container.innerHTML = '<div class="status-text">No documents ingested yet.</div>';
    return;
  }

  container.innerHTML = "";
  for (const docId of docIds) {
    const info = manifest[docId]!;
    const chunks = Object.keys(searchIndex)
      .filter((k) => k.startsWith(`${docId}/`))
      .sort(compareChunkIds);

    const item = document.createElement("div");
    item.className = "doc-item";

    const label = document.createElement("div");
    label.className = "doc-label";
    label.innerHTML = `<span class="caret">▶</span><span>${info.title || info.originalFilename}</span>`;

    const chunkList = document.createElement("div");
    chunkList.className = "chunk-list";

    // Single source of truth: render exactly the index keys, _index sorted first.
    for (const chunkId of chunks) {
      const [, label] = splitId(chunkId); // "aaa/_index" → "_index", "aaa/01" → "01"
      chunkList.appendChild(createChunkItem(chunkId, label));
    }

    label.addEventListener("click", () => {
      const open = label.classList.toggle("open");
      chunkList.classList.toggle("open", open);
    });

    item.appendChild(label);
    item.appendChild(chunkList);
    container.appendChild(item);
  }

  refreshSelection();
}

function renderSearchResults(query: string) {
  const container = el("doc-tree");
  const results = search(searchIndex, query.trim());
  container.innerHTML = "";

  if (results.length === 0) {
    container.innerHTML = '<div class="status-text">No results.</div>';
    return;
  }

  for (const r of results.slice(0, 30)) {
    const row = document.createElement("div");
    row.className = "search-result-item";
    row.dataset.id = r.id;
    if (r.id === selectedId) row.classList.add("selected");

    const idSpan = document.createElement("span");
    idSpan.textContent = r.id;

    const scoreSpan = document.createElement("span");
    scoreSpan.className = "search-score";
    scoreSpan.textContent = String(r.score);

    row.appendChild(idSpan);
    row.appendChild(scoreSpan);
    row.addEventListener("click", () => selectChunk(r.id));
    container.appendChild(row);
  }
}

function createChunkItem(chunkId: string, label: string): HTMLElement {
  const item = document.createElement("div");
  item.className = "chunk-item";
  item.dataset.id = chunkId;
  if (chunkId === selectedId) item.classList.add("selected");
  item.textContent = label;
  item.addEventListener("click", () => selectChunk(chunkId));
  return item;
}

function refreshSelection() {
  document.querySelectorAll<HTMLElement>(".chunk-item, .search-result-item").forEach((node) => {
    node.classList.toggle("selected", node.dataset.id === selectedId);
  });
}

// ── Left Panel: Preview ───────────────────────────────────────────────────────

async function selectChunk(id: string) {
  selectedId = id;
  refreshSelection();

  const previewArea = el("preview-area");
  previewArea.innerHTML = '<div class="status-text">Loading…</div>';

  try {
    const res = await fetch(`db/${id}.md`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();

    const idEl = document.createElement("div");
    idEl.className = "preview-id";
    idEl.textContent = id;

    previewArea.innerHTML = "";
    previewArea.appendChild(idEl);

    // No body: show a "no content" note (not a blank pane); nav bar stays up.
    if (text.trim()) {
      const pre = document.createElement("pre");
      pre.className = "preview-content";
      pre.textContent = text;
      previewArea.appendChild(pre);
    } else {
      const note = document.createElement("div");
      note.className = "status-text";
      note.textContent =
        "This section has no direct content of its own. Use the buttons below to view its subsections or parent.";
      previewArea.appendChild(note);
    }

    el("nav-bar").style.display = "flex";
  } catch (err) {
    previewArea.innerHTML = `<div class="status-text">Failed to load: ${err instanceof Error ? err.message : String(err)}</div>`;
  }
}

// ── Left Panel: Search ────────────────────────────────────────────────────────

function setupSearch() {
  let debounce: ReturnType<typeof setTimeout>;
  el<HTMLInputElement>("search-input").addEventListener("input", (e) => {
    clearTimeout(debounce);
    const q = (e.target as HTMLInputElement).value.trim();
    debounce = setTimeout(() => (q ? renderSearchResults(q) : renderDocTree()), 200);
  });
}

// ── Left Panel: Nav buttons ───────────────────────────────────────────────────

function setupNav() {
  el("btn-parent").addEventListener("click", () => {
    if (!selectedId) return;
    const p = parent(selectedId);
    if (p) selectChunk(p);
  });

  el("btn-siblings").addEventListener("click", () => {
    if (!selectedId) return;
    const sibs = siblings(searchIndex, selectedId);
    showNavList(`Siblings of ${selectedId}`, sibs);
  });

  el("btn-expand").addEventListener("click", () => {
    if (!selectedId) return;
    const ids = expand(searchIndex, selectedId, 2).sort();
    showNavList(`Expanded context for ${selectedId}`, ids);
  });
}

function showNavList(heading: string, ids: string[]) {
  const previewArea = el("preview-area");

  const h = document.createElement("div");
  h.className = "preview-id";
  h.textContent = heading;

  const list = document.createElement("div");
  list.className = "nav-chunk-list";

  if (ids.length === 0) {
    const empty = document.createElement("div");
    empty.className = "status-text";
    empty.textContent = "None.";
    list.appendChild(empty);
  }

  for (const id of ids) {
    list.appendChild(createChunkItem(id, id));
  }

  previewArea.innerHTML = "";
  previewArea.appendChild(h);
  previewArea.appendChild(list);
}

// ── Right Panel: API Key ──────────────────────────────────────────────────────

function setupApiKey() {
  const saved = sessionStorage.getItem("knowdb-api-key");
  if (saved) el<HTMLInputElement>("api-key-input").value = saved;

  el("btn-save-key").addEventListener("click", () => {
    const key = el<HTMLInputElement>("api-key-input").value.trim();
    if (key) {
      sessionStorage.setItem("knowdb-api-key", key);
      appendStatus("API key saved for this session.");
    }
  });
}

function getApiKey(): string {
  return (
    el<HTMLInputElement>("api-key-input").value.trim() ||
    sessionStorage.getItem("knowdb-api-key") ||
    ""
  );
}

// ── Right Panel: JSONL exports (gaps / traces) ────────────────────────────────

/** Wire a button to download a JSONL blob; show a status line when empty. */
function setupJsonlDownload(
  buttonId: string,
  dump: () => string,
  filename: () => string,
  emptyMessage: string
) {
  el(buttonId).addEventListener("click", () => {
    const jsonl = dump();
    if (!jsonl.trim()) {
      appendStatus(emptyMessage);
      return;
    }
    const url = URL.createObjectURL(new Blob([jsonl], { type: "application/x-ndjson" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename();
    a.click();
    URL.revokeObjectURL(url);
  });
}

const setupGapExport = () =>
  setupJsonlDownload("btn-export-gaps", () => gapSink.dump(), () => "query-gaps.jsonl", "No query gaps recorded yet.");

const setupTraceExport = () =>
  setupJsonlDownload(
    "btn-export-traces",
    () => traceSink.dump(),
    () => `knowdb-traces-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.jsonl`,
    "No query traces recorded yet."
  );

// ── Right Panel: Chat ─────────────────────────────────────────────────────────

// Single owner of turn-active state: controller, Send/Stop button, and search
// lock move together.
function setActiveAbort(ac: AbortController | null) {
  activeAbort = ac;
  const btn = el("btn-send");
  btn.textContent = ac ? "Stop" : "Send";
  btn.classList.toggle("btn-stop", ac !== null);
  if (ac) el("search-input").setAttribute("disabled", "");
  else el("search-input").removeAttribute("disabled");
}

function setupChat() {
  el("btn-send").addEventListener("click", () => {
    if (activeAbort) activeAbort.abort();
    else void sendMessage();
  });
  el<HTMLTextAreaElement>("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!activeAbort) void sendMessage();
    }
  });
}

function appendBubble(role: "user" | "assistant", text: string): HTMLElement {
  const container = el("chat-messages");
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
  return bubble;
}

function appendStatus(msg: string) {
  const container = el("chat-messages");
  const div = document.createElement("div");
  div.className = "status-text";
  div.textContent = msg;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function appendToolTrace(toolName: string, input: unknown, result: string) {
  const container = el("chat-messages");

  const details = document.createElement("details");
  details.className = "tool-trace";

  const summary = document.createElement("summary");
  const inputStr = JSON.stringify(input);
  summary.textContent = `🔧 ${toolName}(${inputStr.length > 50 ? inputStr.slice(0, 50) + "…" : inputStr})`;

  const body = document.createElement("div");
  body.className = "tool-trace-body";
  body.textContent = `Input:\n${JSON.stringify(input, null, 2)}\n\nResult:\n${truncateOutput(result)}`;

  details.appendChild(summary);
  details.appendChild(body);
  container.appendChild(details);
  container.scrollTop = container.scrollHeight;
}

async function sendMessage() {
  const input = el<HTMLTextAreaElement>("chat-input");
  const text = input.value.trim();
  if (!text) return;

  const apiKey = getApiKey();
  if (!apiKey) {
    appendStatus("Please enter and save your Anthropic API key first.");
    return;
  }

  input.value = "";
  const ac = new AbortController();
  setActiveAbort(ac);
  // Restore the doc tree so the user can't rebuild it out from under the live highlight.
  renderDocTree();

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  let thinkingBubble: HTMLElement | null = null;

  try {
    await runAgentTurn(
      {
        client,
        collector: traceCollector,
        traceSink,
        gapSink,
        searchIndex,
        manifest,
        model: MODEL.id,
        maxTokens: MAX_OUTPUT_TOKENS,
        system:
          "You are a helpful assistant with access to a knowledge base via tools. " +
          "Call get_instructions first to learn how to use the tools. Be concise in your final answer.",
        tools: KNOWDB_TOOLS,
        chatHistory,
        signal: ac.signal,
        hooks: {
          onUserMessage: (t) => appendBubble("user", t),
          onThinkingStart: () => {
            thinkingBubble = appendBubble("assistant", "Thinking…");
          },
          onToolsStart: () => {
            if (thinkingBubble) thinkingBubble.textContent = "Using tools…";
          },
          onToolCall: (name, inp, result) => appendToolTrace(name, inp, result),
          onAssistantMessage: (t) => {
            if (thinkingBubble) thinkingBubble.remove();
            appendBubble("assistant", t || "(no response)");
          },
          onError: (err) => {
            const msg = `Error: ${err instanceof Error ? err.message : String(err)}`;
            if (thinkingBubble) thinkingBubble.textContent = msg;
            else appendStatus(msg);
          },
          onAbort: () => {
            if (thinkingBubble) {
              thinkingBubble.remove();
              thinkingBubble = null;
            }
            appendStatus("Stopped.");
          },
        },
      },
      text
    );
  } finally {
    setActiveAbort(null);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init();
