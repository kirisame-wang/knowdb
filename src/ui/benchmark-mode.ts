// Benchmark mode UI, gated behind ?benchmark=1: mounts an overlay that runs the
// ablation matrix over a question set and renders the report. Without the flag the
// module is inert (no DOM, no fetch, no API call), so the normal chat page is untouched.
//
// Safeguards (it spends real tokens): mounts only behind the flag; runs only on an
// explicit button; a persistent cost warning is shown; needs an API key; non-reentrant
// and stoppable; the live path is not reached by tests.

import Anthropic from "@anthropic-ai/sdk";
import { KNOWDB_TOOLS } from "../agent/tools.js";
import { runBenchmark } from "../benchmark/runner.js";
import {
  BENCHMARK_VARIANTS,
  estimateRun,
  buildRun,
  collectReport,
  renderReportText,
  reportView,
  variantRowCells,
  successRowCells,
  axisDeltaColumns,
  axisDeltaRowCells,
} from "../benchmark/report.js";
import type { ReportView } from "../benchmark/report.js";
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
const SYSTEM_PROMPT =
  "You are a helpful assistant with access to a knowledge base via tools. " +
  "Call get_instructions first to learn how to use the tools. Be concise in your final answer.";

const QUESTION_SET_PATH = "benchmark/smoke.json";

// (variant × problem) threads in flight — a modest cap to cut wall-clock while
// staying well under the API rate limit.
const RUN_CONCURRENCY = 4;

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

// Build the report as DOM blocks (headings + real tables) from the pure view.
export function renderReport(view: ReportView): HTMLElement {
  const root = document.createElement("div");
  root.appendChild(block("h1", view.title, "font-size:16px;margin:0 0 6px"));
  root.appendChild(block("p", view.disclaimer, "margin:4px 0;color:#656d76;font-size:12px;border-left:3px solid #d0d7de;padding-left:10px"));
  root.appendChild(block("p", view.meta, "margin:4px 0;color:#656d76;font-size:12px"));

  root.appendChild(block("h2", "Per-variant (cost + behavior)", "font-size:13px;margin:14px 0 4px"));
  root.appendChild(tableEl(view.perVariant.columns, view.perVariant.rows.map(variantRowCells)));

  if (view.success) {
    root.appendChild(block("h2", "Success (pilot — steps/tokens gated on reach)", "font-size:13px;margin:14px 0 4px"));
    root.appendChild(tableEl(view.success.columns, view.success.rows.map(successRowCells)));
  }

  const withSucc = view.success !== undefined;
  root.appendChild(block("h2", "Per-axis ablation deltas", "font-size:13px;margin:14px 0 4px"));
  root.appendChild(block("p", "Δ = axis-off variant minus baseline (what happens when the axis is removed). A useful axis shows success down (−) and steps up (+).", "margin:4px 0;color:#656d76;font-size:12px"));
  root.appendChild(tableEl(axisDeltaColumns(withSucc), view.axisDeltas.map((d) => axisDeltaRowCells(d, withSucc))));

  root.appendChild(block("h2", "Cost story", "font-size:13px;margin:14px 0 4px"));
  const c = view.cost;
  root.appendChild(block("p", `Realized usage (all variants): ${c.realized.input} in / ${c.realized.output} out tokens and ${c.realized.steps} tool calls (rounds) over ${c.realized.turns} turns.`, "margin:4px 0"));
  root.appendChild(
    c.ratio
      ? block(
          "p",
          `Token ratio ${c.ratio.baseline} vs ${c.ratio.external} (floor): input ×${c.ratio.input.toFixed(2)}, output ×${c.ratio.output.toFixed(2)} (>1 = full config costs more than the search+read floor — that floor drops the navigation tools but keeps search-hit structure).`,
          "margin:4px 0",
        )
      : block("p", "No token ratio: the cost-floor variant produced no turns (partial or aborted run).", "margin:4px 0;color:#656d76"),
  );
  if (c.ratio?.steps !== undefined) {
    root.appendChild(block("p", `Calls (rounds) ratio ${c.ratio.baseline} vs ${c.ratio.external} (floor): ×${c.ratio.steps.toFixed(2)} (>1 = full takes more tool-call rounds than the floor; rounds re-send input each turn — a cost axis tokens reflect only indirectly).`, "margin:4px 0"));
  }
  return root;
}

// Loud red banner when turns errored (or the whole run spent nothing) — so a failed
// run is never mistaken for a real one.
export function renderErrors(errors: string[], noWork: boolean): HTMLElement {
  const box = document.createElement("div");
  box.style.cssText = "margin:0 0 12px;padding:10px 12px;border:1px solid #cf222e;border-radius:6px;background:#fff5f5;color:#cf222e;font-size:12px";
  box.appendChild(
    block(
      "p",
      noWork
        ? "This run made no successful API call (0 tokens). Likely a bad/missing API key, model id, or network error — nothing was actually tested."
        : "Some turns errored.",
      "margin:0 0 6px;font-weight:600",
    ),
  );
  if (errors.length === 0) {
    box.appendChild(block("p", "No error detail was captured.", "margin:0"));
    return box;
  }
  const list = document.createElement("ul");
  list.style.cssText = "margin:0;padding-left:18px;font-family:SFMono-Regular,Consolas,monospace";
  for (const e of errors.slice(0, 8)) {
    const li = document.createElement("li");
    li.textContent = e;
    list.appendChild(li);
  }
  if (errors.length > 8) {
    const li = document.createElement("li");
    li.textContent = `…and ${errors.length - 8} more`;
    list.appendChild(li);
  }
  box.appendChild(list);
  return box;
}

export async function mountBenchmarkMode(): Promise<void> {
  const panel = elFromHtml(`
    <div id="knowdb-benchmark" style="position:fixed;inset:0;z-index:9999;background:#fff;display:flex;flex-direction:column;font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#1f2328">
      <div style="display:flex;align-items:center;gap:8px;padding:10px 16px;background:#f6f8fa;border-bottom:1px solid #d0d7de;flex-wrap:wrap">
        <strong>KnowDB Benchmark</strong>
        <span id="benchmark-status" style="color:#656d76;font-size:12px"></span>
        <span style="flex:1"></span>
        <input id="benchmark-api-key" type="password" placeholder="sk-ant-… Anthropic API key" autocomplete="off" spellcheck="false" style="height:30px;width:230px;padding:0 8px;border:1px solid #d0d7de;border-radius:6px;font-family:SFMono-Regular,Consolas,monospace;font-size:12px" />
        <button id="benchmark-save-key" style="height:30px;padding:0 10px;border:1px solid #d0d7de;border-radius:6px;background:#fff;cursor:pointer;font-size:12px">Save</button>
        <button id="benchmark-run" style="height:30px;padding:0 16px;border:none;border-radius:6px;background:#0969da;color:#fff;cursor:pointer;font-weight:500">Run benchmark</button>
        <a href="?" style="height:30px;line-height:30px;padding:0 12px;border:1px solid #d0d7de;border-radius:6px;color:#1f2328;text-decoration:none">Exit</a>
      </div>
      <div id="benchmark-meta" style="padding:10px 16px 4px;color:#656d76;font-size:12px"></div>
      <div id="benchmark-warning" style="padding:0 16px 10px;border-bottom:1px solid #d0d7de;color:#cf222e;font-size:12px;font-weight:500"></div>
      <div id="benchmark-downloads" style="display:none;gap:8px;padding:8px 16px;border-bottom:1px solid #d0d7de"></div>
      <div id="benchmark-report" style="flex:1;overflow:auto;margin:0;padding:16px;line-height:1.5"></div>
    </div>
  `);
  document.body.appendChild(panel);

  const $ = <T extends HTMLElement>(id: string): T => panel.querySelector(`#${id}`) as T;
  const statusEl = $("benchmark-status");
  const metaEl = $("benchmark-meta");
  const warnEl = $("benchmark-warning");
  const reportEl = $<HTMLDivElement>("benchmark-report");
  const runBtn = $<HTMLButtonElement>("benchmark-run");
  const apiKeyInput = $<HTMLInputElement>("benchmark-api-key");
  const saveKeyBtn = $<HTMLButtonElement>("benchmark-save-key");
  const downloadsEl = $<HTMLDivElement>("benchmark-downloads");
  const setStatus = (s: string): void => void (statusEl.textContent = s);

  // API key input mirrors the demo's, sharing the same session key. No popups.
  apiKeyInput.value = sessionStorage.getItem("knowdb-api-key") ?? "";
  const apiKey = (): string => apiKeyInput.value.trim() || sessionStorage.getItem("knowdb-api-key") || "";
  saveKeyBtn.addEventListener("click", () => {
    sessionStorage.setItem("knowdb-api-key", apiKeyInput.value.trim());
    setStatus("API key saved for this session.");
  });

  // Load the static index + manifest and the question set.
  let searchIndex: SearchIndex = {};
  let manifest: Manifest = {};
  let problems: BenchmarkProblem[] = [];
  try {
    const [idx, man, questionSet] = await Promise.all([
      fetch("db/_search_index.json").then((r) => (r.ok ? r.json() : {})),
      fetch("db/_manifest.json").then((r) => (r.ok ? r.json() : {})),
      fetch(QUESTION_SET_PATH).then((r) => {
        if (!r.ok) throw new Error(`${QUESTION_SET_PATH}: HTTP ${r.status}`);
        return r.json();
      }),
    ]);
    searchIndex = idx as SearchIndex;
    manifest = man as Manifest;
    problems = questionSet as BenchmarkProblem[];
  } catch (err) {
    setStatus(`Failed to load: ${err instanceof Error ? err.message : String(err)}`);
    runBtn.disabled = true;
    return;
  }

  const est = estimateRun(problems, BENCHMARK_VARIANTS);
  metaEl.textContent =
    `${est.variantCount} variants × ${est.turnCount} turns = ${est.units} agent turns · ` +
    `(${BENCHMARK_VARIANTS.join(", ")})`;
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
      setStatus("Enter your Anthropic API key first.");
      return;
    }

    const ac = new AbortController();
    setRunning(ac);
    downloadsEl.style.display = "none";
    reportEl.textContent = "";

    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    const runId = `run-${nowStamp()}`;
    const startedAt = new Date().toISOString();
    const errors: string[] = [];

    try {
      await runBenchmark({
        client,
        store: window.localStorage,
        session: new SessionContext(),
        searchIndex,
        manifest,
        model: MODEL.id,
        system: SYSTEM_PROMPT,
        maxTokens: MAX_OUTPUT_TOKENS,
        tools: KNOWDB_TOOLS,
        problems,
        variants: [...BENCHMARK_VARIANTS],
        runId,
        concurrency: RUN_CONCURRENCY,
        signal: ac.signal,
        onProgress: (done, total, label) => setStatus(`${done}/${total} — ${label}`),
        onError: (err, label) => errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`),
      });

      const run = buildRun({
        runId,
        knowdbCommitSha: "unknown (browser)",
        tools: KNOWDB_TOOLS,
        problemSetId: "pilot",
        startedAt,
        endedAt: new Date().toISOString(),
        reviewer: "",
      });
      const report = collectReport(window.localStorage, runId, problems, run);
      const view = reportView(report, problems);
      reportEl.textContent = "";
      // Loud failure: no tokens means no API call succeeded — don't dress it up as Done.
      const noWork = view.cost.realized.input + view.cost.realized.output === 0;
      if (errors.length || noWork) reportEl.appendChild(renderErrors(errors, noWork));
      reportEl.appendChild(renderReport(view));
      setStatus(
        ac.signal.aborted
          ? "Stopped — partial report below."
          : noWork
            ? `⚠ No tokens spent — ${errors.length} turn(s) errored. The run did not execute.`
            : errors.length
              ? `Done with ${errors.length} error(s) — see top of report.`
              : "Done.",
      );
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
    add("⤓ report.md", () => ({ name: `${runId}-report.md`, text: renderReportText(report, problems), mime: "text/markdown" }));
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
