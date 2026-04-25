import Anthropic from "@anthropic-ai/sdk";
import { KNOWDB_TOOLS, processToolCall } from "./agent/tools.js";
import { search, expand, siblings, parent } from "./db_query.js";
import type { SearchIndex } from "./types.js";

// ── State ─────────────────────────────────────────────────────────────────────

let searchIndex: SearchIndex = {};
let manifest: Record<string, { originalFilename: string; title: string }> = {};
let selectedId: string | null = null;
const chatHistory: Anthropic.Messages.MessageParam[] = [];

// ── DOM helpers ───────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// ── Init ──────────────────────────────────────────────────────────────────────

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
      .sort();

    const item = document.createElement("div");
    item.className = "doc-item";

    const label = document.createElement("div");
    label.className = "doc-label";
    label.innerHTML = `<span class="caret">▶</span><span>${info.title || info.originalFilename}</span>`;

    const chunkList = document.createElement("div");
    chunkList.className = "chunk-list";

    // _index.md first — gives a TOC overview of the document
    chunkList.appendChild(createChunkItem(`${docId}/_index`, "_index"));

    for (const chunkId of chunks) {
      const chunkItem = createChunkItem(chunkId, chunkId.split("/")[1]!);
      chunkList.appendChild(chunkItem);
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

    const pre = document.createElement("pre");
    pre.className = "preview-content";
    pre.textContent = text;

    previewArea.innerHTML = "";
    previewArea.appendChild(idEl);
    previewArea.appendChild(pre);

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

// ── Right Panel: Chat ─────────────────────────────────────────────────────────

function setupChat() {
  el("btn-send").addEventListener("click", sendMessage);
  el<HTMLTextAreaElement>("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!el("btn-send").hasAttribute("disabled")) sendMessage();
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
  body.textContent = `Input:\n${JSON.stringify(input, null, 2)}\n\nResult:\n${result.length > 600 ? result.slice(0, 600) + "\n… (truncated)" : result}`;

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
  el("btn-send").setAttribute("disabled", "");
  appendBubble("user", text);
  chatHistory.push({ role: "user", content: text });

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const thinkingBubble = appendBubble("assistant", "Thinking…");

  try {
    // Tool-use agentic loop
    while (true) {
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        system:
          "You are a helpful assistant with access to a knowledge base via tools. " +
          "Call get_instructions first to learn how to use the tools. Be concise in your final answer.",
        tools: KNOWDB_TOOLS,
        messages: chatHistory,
      });

      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

      if (toolUseBlocks.length === 0) {
        const finalText = response.content
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");

        thinkingBubble.remove();
        appendBubble("assistant", finalText || "(no response)");
        chatHistory.push({ role: "assistant", content: response.content });
        break;
      }

      thinkingBubble.textContent = "Using tools…";
      chatHistory.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        if (block.type !== "tool_use") continue;
        const result = await processToolCall(
          block.name,
          block.input as Record<string, unknown>,
          searchIndex,
          manifest
        );
        appendToolTrace(block.name, block.input, result);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }

      chatHistory.push({ role: "user", content: toolResults });
    }
  } catch (err) {
    thinkingBubble.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    el("btn-send").removeAttribute("disabled");
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init();
