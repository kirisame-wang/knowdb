// Free-form side-by-side ablation compare (its own ?compare=1 full-screen mode,
// not the scoring overlay): three fixed arms, each a persistent mini main-UI chat.
// A question runs one real agent turn per arm concurrently; follow-ups continue
// each arm's own conversation. No ground truth / no scoring — it shows convergence
// vs flailing. Spends real tokens, so it carries the overlay's safeguards (API
// key, cost warning, Stop). Inert without the flag.

import Anthropic from "@anthropic-ai/sdk";
import { KNOWDB_TOOLS } from "../agent/tools.js";
import { runAgentTurn } from "../agent/loop.js";
import { BrowserTraceCollector } from "../traces.js";
import { toolsFor, ablateResult } from "../benchmark/ablation.js";
import { SessionContext, isContextOverflowError } from "../utils.js";
import { MODEL, MAX_OUTPUT_TOKENS, SYSTEM_PROMPT } from "../constants.js";
import { mountLane } from "./compare-lane.js";
import { hasFlag, elFromHtml, wireApiKey, setRunButton } from "./mode-helpers.js";
import type { SearchIndex, Manifest } from "../types.js";
import type { TraceSink } from "../traces.js";
import type { GapSink } from "../gaps.js";

// The fixed three-arm ladder of structure supply: full tools → search+read floor
// (nav tools dropped, hit structure kept) → structure stripped from hits.
export const COMPARE_ARMS = ["full", "no_structure", "baseline_search_read"] as const;

// One-line description of what each arm gives the agent, shown on hovering the
// ⓘ next to the arm name. Mirrors ablation.ts (toolsFor + ablateResult).
const ARM_HINTS: Record<string, string> = {
  full: "Full tool set — search plus the navigation tools (index, siblings, parent, jump, reconstruct).",
  no_structure: "Structure stripped — search hits lose breadcrumb/siblings, and index/parent reads are blanked.",
  baseline_search_read: "Floor — search + read_chunk only (navigation tools dropped); search hits keep their structure.",
};

// The lanes render live from the collector, but runAgentTurn still wants sinks —
// this demo persists nothing.
const NOOP_TRACE_SINK: TraceSink = { flush() {}, readAll: () => [] };
const NOOP_GAP_SINK: GapSink = { record() {}, readAll: () => [] };

// Panel CSS (topbar / lanes / lane header / composer). The lane bodies reuse the
// main UI's .chat-bubble / .tool-trace / --c-* (defined in index.html).
const STYLE = `
#knowdb-compare{position:fixed;inset:0;z-index:9999;background:#fff;display:flex;flex-direction:column;font-family:-apple-system,Segoe UI,sans-serif;color:#1f2328}
#knowdb-compare .cmp-topbar{display:flex;align-items:center;gap:8px;padding:10px 16px;background:#f6f8fa;border-bottom:1px solid #d0d7de;flex-wrap:wrap}
#knowdb-compare .cmp-topbar .grow{flex:1}
#knowdb-compare .cmp-topbar input{height:30px;width:240px;padding:0 8px;border:1px solid #d0d7de;border-radius:6px;font-family:var(--font-mono,monospace);font-size:12px}
#knowdb-compare .cmp-topbar button,#knowdb-compare .cmp-topbar a{height:30px;line-height:28px;padding:0 12px;border:1px solid #d0d7de;border-radius:6px;background:#fff;cursor:pointer;font-size:12px;color:#1f2328;text-decoration:none}
#knowdb-compare .cmp-lanes-wrap{flex:1;overflow:auto;padding:14px 16px}
#knowdb-compare .cmp-lanes{display:flex;gap:12px;height:100%}
#knowdb-compare .lane{flex:1 1 0;min-width:0;border:1px solid #d0d7de;border-radius:8px;overflow:hidden;background:#fff;display:flex;flex-direction:column;height:100%}
#knowdb-compare .lane-head{padding:8px 12px;background:#f6f8fa;border-bottom:1px solid #d0d7de}
#knowdb-compare .lane-name{font-weight:600;font-size:13px;font-family:var(--font-mono,monospace)}
#knowdb-compare .lane-info{cursor:help;opacity:.55;font-weight:normal;font-size:11px;margin-left:5px}
#knowdb-compare .lane-status{font-size:12px;margin-top:3px;display:flex;align-items:center;gap:8px;color:#656d76}
#knowdb-compare .tok{cursor:help;opacity:.6}
#knowdb-compare .badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:600}
#knowdb-compare .badge.answered{background:#dafbe1;color:#1a7f37}
#knowdb-compare .badge.running{background:#fff8c5;color:#9a6700}
#knowdb-compare .badge.overflow{background:#ffebe9;color:#cf222e}
#knowdb-compare .badge.aborted{background:#eaeef2;color:#656d76}
#knowdb-compare .badge.errored{background:#ffebe9;color:#cf222e}
#knowdb-compare .badge.idle{background:#eaeef2;color:#656d76}
#knowdb-compare .cmp-composer{border-top:1px solid #d0d7de;background:#fff;padding:8px 16px 12px}
#knowdb-compare .cmp-warn{color:#cf222e;font-weight:500;font-size:12px;margin-bottom:6px}
#knowdb-compare .cmp-inputrow{display:flex;gap:8px;align-items:stretch}
#knowdb-compare .cmp-inputrow textarea{flex:1;border:1px solid #d0d7de;border-radius:6px;padding:8px 10px;font-size:13px;font-family:inherit;resize:none}
#knowdb-compare .cmp-inputrow button{padding:0 18px;border:none;border-radius:6px;background:#0969da;color:#fff;font-weight:500;cursor:pointer;font-size:14px}
`;

interface Arm {
  variant: string;
  collector: BrowserTraceCollector;
  chatHistory: Anthropic.Messages.MessageParam[];
}

export async function mountCompareMode(): Promise<void> {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.appendChild(style);

  const panel = elFromHtml(`
    <div id="knowdb-compare">
      <div class="cmp-topbar">
        <strong>KnowDB · side-by-side ablation compare</strong>
        <span class="grow"></span>
        <input id="compare-api-key" type="password" placeholder="sk-ant-… Anthropic API key" autocomplete="off" spellcheck="false" />
        <button id="compare-save-key">Save</button>
        <a href="?">Exit</a>
      </div>
      <div class="cmp-lanes-wrap"><div class="cmp-lanes" id="compare-lanes"></div></div>
      <div class="cmp-composer">
        <div class="cmp-warn" id="compare-warn"></div>
        <div class="cmp-inputrow">
          <textarea id="compare-q" rows="2" placeholder="Ask anything… (Enter to send, Shift+Enter for newline)"></textarea>
          <button id="compare-run">▶ Ask</button>
        </div>
      </div>
    </div>`);
  document.body.appendChild(panel);

  const $ = <T extends HTMLElement>(id: string): T => panel.querySelector(`#${id}`) as T;
  const lanesEl = $("compare-lanes");
  const warnEl = $("compare-warn");
  const qInput = $<HTMLTextAreaElement>("compare-q");
  const runBtn = $<HTMLButtonElement>("compare-run");
  const apiKeyInput = $<HTMLInputElement>("compare-api-key");
  const saveKeyBtn = $<HTMLButtonElement>("compare-save-key");

  // Shares the demo's session API-key slot. No popups.
  const apiKey = wireApiKey(apiKeyInput, saveKeyBtn);

  // One persistent lane per arm: its own collector, conversation history, and
  // column, mounted from the start (idle, showing the arm name) and reused for
  // every question so follow-ups continue each arm's own conversation.
  const session = new SessionContext();
  lanesEl.innerHTML = "";
  const arms: Arm[] = COMPARE_ARMS.map((variant) => {
    const col = document.createElement("div");
    col.className = "lane";
    lanesEl.appendChild(col);
    const collector = new BrowserTraceCollector(session);
    mountLane(variant, collector, col, MODEL.pricing, ARM_HINTS[variant]);
    return { variant, collector, chatHistory: [] };
  });

  // Load the static index + manifest the agent navigates.
  let searchIndex: SearchIndex = {};
  let manifest: Manifest = {};
  try {
    const [idx, man] = await Promise.all([
      fetch("db/_search_index.json").then((r) => (r.ok ? r.json() : {})),
      fetch("db/_manifest.json").then((r) => (r.ok ? r.json() : {})),
    ]);
    searchIndex = idx as SearchIndex;
    manifest = man as Manifest;
  } catch {
    warnEl.textContent = "Failed to load db/ — cannot run.";
    runBtn.disabled = true;
    return;
  }

  warnEl.textContent =
    `⚠ Spends real API tokens — ${COMPARE_ARMS.length} live agent turns per question (more as the conversation grows). Runs on submit.`;

  let running: AbortController | null = null;
  const setRunning = (ac: AbortController | null): void => {
    running = ac;
    setRunButton(runBtn, !!ac, "▶ Ask");
  };

  // Run one turn per arm concurrently; each continues its own chatHistory, so the
  // lanes accumulate the conversation across questions. This live path spends real
  // tokens and is left untested, as with benchmark-mode's live overlay — the lane
  // reducer it drives is covered in compare-lane's unit/integration tests.
  async function ask(): Promise<void> {
    const key = apiKey();
    const question = qInput.value.trim();
    if (!key) { warnEl.textContent = "Enter your Anthropic API key first."; return; }
    if (!question) return;
    qInput.value = ""; // clear the composer once the run is committed, like the main chat

    const ac = new AbortController();
    setRunning(ac);
    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });

    try {
      await Promise.all(
        arms.map((arm) =>
          runAgentTurn(
            {
              client,
              collector: arm.collector,
              traceSink: NOOP_TRACE_SINK,
              gapSink: NOOP_GAP_SINK,
              searchIndex,
              manifest,
              model: MODEL.id,
              system: SYSTEM_PROMPT,
              tools: toolsFor(arm.variant, KNOWDB_TOOLS),
              maxTokens: MAX_OUTPUT_TOKENS,
              chatHistory: arm.chatHistory,
              ablation: (name, result) => ablateResult(arm.variant, name, result),
              signal: ac.signal,
              hooks: {
                onError: (err) => {
                  // The lane already shows overflow; surface only real errors (e.g. a bad key).
                  const msg = err instanceof Error ? err.message : String(err);
                  if (!isContextOverflowError(msg)) warnEl.textContent = `⚠ ${msg}`;
                },
              },
            },
            question,
          ),
        ),
      );
    } finally {
      setRunning(null);
    }
  }

  runBtn.addEventListener("click", () => {
    if (running) { running.abort(); return; }
    void ask();
  });
  qInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!running) void ask();
    }
  });
}

// Inert unless the flag is set.
if (typeof window !== "undefined" && hasFlag("compare")) {
  void mountCompareMode();
}
