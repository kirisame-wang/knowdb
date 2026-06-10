// Benchmark mode UI, gated behind ?benchmark=1. With the flag it mounts an overlay
// panel, reuses the page's static db/ index + manifest and the session API key, runs
// the ablation matrix over a question set, and renders the report. It currently drives
// the no-ground-truth smoke set and shows only success-independent metrics; the same
// shell carries forward as the question set evolves. Without the flag the module is
// inert — no DOM, no fetch, no API call — so the normal chat page is unaffected.
//
// Safeguards (it spends real tokens): mounts only behind the flag; runs only on an
// explicit button, never on load; a cost-preview confirm precedes the first request;
// the run is non-reentrant and stoppable; the live path needs an API key and is not
// reached by tests.

import Anthropic from "@anthropic-ai/sdk";
import { KNOWDB_TOOLS } from "../agent/tools.js";
import { runBenchmark } from "../benchmark/runner.js";
import {
  SMOKE_VARIANTS,
  estimateRun,
  buildSmokeRun,
  collectSmokeReport,
  renderSmokeReportText,
  smokeReportView,
  variantRowCells,
} from "../benchmark/smoke.js";
import type { SmokeReportView } from "../benchmark/smoke.js";
import {
  benchmarkTraceKey,
  benchmarkGapKey,
  benchmarkVariantKey,
} from "../benchmark/sink.js";
import { SessionContext } from "../utils.js";
import { MODEL, MAX_OUTPUT_TOKENS } from "../constants.js";
import type { SearchIndex, Manifest } from "../types.js";
import type { BenchmarkProblem, BenchmarkReport } from "../benchmark/types.js";

// Mirrors the chat system prompt so the cost story reflects the real agent.
const SMOKE_SYSTEM =
  "You are a helpful assistant with access to a knowledge base via tools. " +
  "Call get_instructions first to learn how to use the tools. Be concise in your final answer.";

const SMOKE_JSON_PATH = "benchmark/smoke.json";

function isBenchmarkFlag(): boolean {
  return new URLSearchParams(window.location.search).get("benchmark") === "1";
}

function elFromHtml(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

function download(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const fmtUsd = (x: number): string => `$${x.toFixed(2)}`;
const fmtTok = (x: number): string => (x >= 1000 ? `${(x / 1000).toFixed(0)}k` : String(x));

// ── Report rendering (zero-dep DOM; cells via textContent, XSS-safe) ──────────

function tableEl(headers: readonly string[], rows: string[][]): HTMLTableElement {
  const table = document.createElement("table");
  table.style.cssText = "border-collapse:collapse;font-size:12px;margin:6px 0";
  const htr = document.createElement("tr");
  headers.forEach((h, i) => {
    const th = document.createElement("th");
    th.textContent = h;
    th.style.cssText = `text-align:${i === 0 ? "left" : "right"};border-bottom:1px solid #d0d7de;padding:4px 10px;color:#656d76;white-space:nowrap`;
    htr.appendChild(th);
  });
  const thead = document.createElement("thead");
  thead.appendChild(htr);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    r.forEach((cell, i) => {
      const td = document.createElement("td");
      td.textContent = cell;
      td.style.cssText = `text-align:${i === 0 ? "left" : "right"};border-bottom:1px solid #eee;padding:4px 10px${i === 0 ? ";font-family:SFMono-Regular,Consolas,monospace" : ""}`;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function block(tag: "h1" | "h2" | "p", text: string, css = ""): HTMLElement {
  const e = document.createElement(tag);
  e.textContent = text;
  e.style.cssText = css;
  return e;
}

const signedDelta = (x: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

// Build the report as DOM blocks (headings + real tables) from the pure view.
export function renderReport(view: SmokeReportView): HTMLElement {
  const root = document.createElement("div");
  root.appendChild(block("h1", view.title, "font-size:16px;margin:0 0 6px"));
  root.appendChild(block("p", view.disclaimer, "margin:4px 0;color:#656d76;font-size:12px;border-left:3px solid #d0d7de;padding-left:10px"));
  root.appendChild(block("p", view.meta, "margin:4px 0;color:#656d76;font-size:12px"));

  root.appendChild(block("h2", "Per-variant (cost + behavior)", "font-size:13px;margin:14px 0 4px"));
  root.appendChild(tableEl(view.perVariant.columns, view.perVariant.rows.map(variantRowCells)));

  root.appendChild(block("h2", "Cost story", "font-size:13px;margin:14px 0 4px"));
  const c = view.cost;
  root.appendChild(block("p", `Realized usage: ${c.realized.input} in / ${c.realized.output} out tokens over ${c.realized.turns} turns.`, "margin:4px 0"));
  root.appendChild(
    c.ratio
      ? block(
          "p",
          `Token ratio ${c.ratio.baseline} vs ${c.ratio.external} (floor): input ×${c.ratio.input.toFixed(2)}, output ×${c.ratio.output.toFixed(2)} (>1 = full config costs more than the flat search+read floor).`,
          "margin:4px 0",
        )
      : block("p", "No token ratio: the cost-floor variant produced no turns (partial or aborted run).", "margin:4px 0;color:#656d76"),
  );
  root.appendChild(block("p", "Per-axis decision-steps delta (axis-off minus baseline; positive = removing the axis costs more steps):", "margin:8px 0 0;color:#656d76;font-size:12px"));
  root.appendChild(tableEl(["axis-off variant", "Δ avg steps"], c.perAxis.map((d) => [d.variant, signedDelta(d.stepsDelta)])));
  return root;
}

export async function mountBenchmarkMode(): Promise<void> {
  const panel = elFromHtml(`
    <div id="knowdb-smoke" style="position:fixed;inset:0;z-index:9999;background:#fff;display:flex;flex-direction:column;font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#1f2328">
      <div style="display:flex;align-items:center;gap:8px;padding:10px 16px;background:#f6f8fa;border-bottom:1px solid #d0d7de;flex-wrap:wrap">
        <strong>KnowDB Benchmark</strong>
        <span id="smoke-status" style="color:#656d76;font-size:12px"></span>
        <span style="flex:1"></span>
        <input id="smoke-api-key" type="password" placeholder="sk-ant-… Anthropic API key" autocomplete="off" spellcheck="false" style="height:30px;width:230px;padding:0 8px;border:1px solid #d0d7de;border-radius:6px;font-family:SFMono-Regular,Consolas,monospace;font-size:12px" />
        <button id="smoke-save-key" style="height:30px;padding:0 10px;border:1px solid #d0d7de;border-radius:6px;background:#fff;cursor:pointer;font-size:12px">Save</button>
        <button id="smoke-run" style="height:30px;padding:0 16px;border:none;border-radius:6px;background:#0969da;color:#fff;cursor:pointer;font-weight:500">Run benchmark</button>
        <a href="?" style="height:30px;line-height:30px;padding:0 12px;border:1px solid #d0d7de;border-radius:6px;color:#1f2328;text-decoration:none">Exit</a>
      </div>
      <div id="smoke-meta" style="padding:10px 16px 4px;color:#656d76;font-size:12px"></div>
      <div id="smoke-warning" style="padding:0 16px 10px;border-bottom:1px solid #d0d7de;color:#cf222e;font-size:12px;font-weight:500"></div>
      <div id="smoke-downloads" style="display:none;gap:8px;padding:8px 16px;border-bottom:1px solid #d0d7de"></div>
      <div id="smoke-report" style="flex:1;overflow:auto;margin:0;padding:16px;line-height:1.5"></div>
    </div>
  `);
  document.body.appendChild(panel);

  const $ = <T extends HTMLElement>(id: string): T => panel.querySelector(`#${id}`) as T;
  const statusEl = $("smoke-status");
  const metaEl = $("smoke-meta");
  const warnEl = $("smoke-warning");
  const reportEl = $<HTMLDivElement>("smoke-report");
  const runBtn = $<HTMLButtonElement>("smoke-run");
  const apiKeyInput = $<HTMLInputElement>("smoke-api-key");
  const saveKeyBtn = $<HTMLButtonElement>("smoke-save-key");
  const downloadsEl = $<HTMLDivElement>("smoke-downloads");
  const setStatus = (s: string): void => void (statusEl.textContent = s);

  // API key input mirrors the demo's, sharing the same session key. No popups.
  apiKeyInput.value = sessionStorage.getItem("knowdb-api-key") ?? "";
  const apiKey = (): string => apiKeyInput.value.trim() || sessionStorage.getItem("knowdb-api-key") || "";
  saveKeyBtn.addEventListener("click", () => {
    sessionStorage.setItem("knowdb-api-key", apiKeyInput.value.trim());
    setStatus("API key saved for this session.");
  });

  // Load the static index + manifest (same files the demo uses) and the smoke set.
  let searchIndex: SearchIndex = {};
  let manifest: Manifest = {};
  let problems: BenchmarkProblem[] = [];
  try {
    const [idx, man, smoke] = await Promise.all([
      fetch("db/_search_index.json").then((r) => (r.ok ? r.json() : {})),
      fetch("db/_manifest.json").then((r) => (r.ok ? r.json() : {})),
      fetch(SMOKE_JSON_PATH).then((r) => {
        if (!r.ok) throw new Error(`${SMOKE_JSON_PATH}: HTTP ${r.status}`);
        return r.json();
      }),
    ]);
    searchIndex = idx as SearchIndex;
    manifest = man as Manifest;
    problems = smoke as BenchmarkProblem[];
  } catch (err) {
    setStatus(`Failed to load: ${err instanceof Error ? err.message : String(err)}`);
    runBtn.disabled = true;
    return;
  }

  const est = estimateRun(problems, SMOKE_VARIANTS);
  metaEl.textContent =
    `${est.variantCount} variants × ${est.turnCount} turns = ${est.units} agent turns · ` +
    `(${SMOKE_VARIANTS.join(", ")})`;
  // Persistent, prominent cost warning in place of a modal — Run starts immediately.
  warnEl.textContent =
    `⚠ Spends real API tokens. Rough cost ≈ ${fmtUsd(est.estCostUsd)} ` +
    `(≈ ${fmtTok(est.estTokens.input)} in / ${fmtTok(est.estTokens.output)} out, ${MODEL.id}). Run starts immediately on click.`;

  let running: AbortController | null = null;

  const setRunning = (ac: AbortController | null): void => {
    running = ac;
    runBtn.textContent = ac ? "Stop" : "Run benchmark";
    runBtn.style.background = ac ? "#cf222e" : "#0969da";
  };

  runBtn.addEventListener("click", () => {
    if (running) {
      running.abort();
      setStatus("Stopping after the current turn…");
      return;
    }
    void doRun();
  });

  async function doRun(): Promise<void> {
    const key = apiKey();
    if (!key) {
      setStatus("Enter and save your Anthropic API key first.");
      return;
    }
    sessionStorage.setItem("knowdb-api-key", key);

    const ac = new AbortController();
    setRunning(ac);
    downloadsEl.style.display = "none";
    reportEl.textContent = "";

    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    const runId = `smoke-${nowStamp()}`;
    const startedAt = new Date().toISOString();

    try {
      await runBenchmark({
        client,
        store: window.localStorage,
        session: new SessionContext(),
        searchIndex,
        manifest,
        model: MODEL.id,
        system: SMOKE_SYSTEM,
        maxTokens: MAX_OUTPUT_TOKENS,
        tools: KNOWDB_TOOLS,
        problems,
        variants: [...SMOKE_VARIANTS],
        runId,
        signal: ac.signal,
        onProgress: (done, total, label) => setStatus(`${done}/${total} — ${label}`),
      });

      const run = buildSmokeRun({
        runId,
        knowdbCommitSha: "unknown (browser)",
        tools: KNOWDB_TOOLS,
        problemSetId: "smoke",
        startedAt,
        endedAt: new Date().toISOString(),
        reviewer: "",
      });
      const report = collectSmokeReport(window.localStorage, runId, problems, run);
      reportEl.textContent = "";
      reportEl.appendChild(renderReport(smokeReportView(report)));
      setStatus(ac.signal.aborted ? "Stopped — partial report below." : "Done.");
      showDownloads(runId, report);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(null);
    }
  }

  function showDownloads(runId: string, report: BenchmarkReport): void {
    downloadsEl.innerHTML = "";
    const add = (label: string, make: () => { name: string; text: string; mime: string }): void => {
      const b = elFromHtml(
        `<button style="height:26px;padding:0 10px;border:1px solid #d0d7de;border-radius:6px;background:#fff;cursor:pointer;font-size:12px">${label}</button>`,
      );
      b.addEventListener("click", () => {
        const { name, text, mime } = make();
        download(name, text, mime);
      });
      downloadsEl.appendChild(b);
    };
    const ls = window.localStorage;
    add("⤓ traces.jsonl", () => ({ name: `${runId}-traces.jsonl`, text: ls.getItem(benchmarkTraceKey(runId)) ?? "", mime: "application/x-ndjson" }));
    add("⤓ variant-assignments.jsonl", () => ({ name: `${runId}-variant-assignments.jsonl`, text: ls.getItem(benchmarkVariantKey(runId)) ?? "", mime: "application/x-ndjson" }));
    add("⤓ gaps.jsonl", () => ({ name: `${runId}-gaps.jsonl`, text: ls.getItem(benchmarkGapKey(runId)) ?? "", mime: "application/x-ndjson" }));
    add("⤓ report.json", () => ({ name: `${runId}-report.json`, text: JSON.stringify(report, null, 2), mime: "application/json" }));
    add("⤓ report.md", () => ({ name: `${runId}-report.md`, text: renderSmokeReportText(report), mime: "text/markdown" }));
    downloadsEl.style.display = "flex";
  }

  setStatus("Ready.");
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// Inert unless the flag is set.
if (typeof window !== "undefined" && isBenchmarkFlag()) {
  void mountBenchmarkMode();
}
