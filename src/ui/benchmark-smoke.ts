// Browser smoke-run harness, gated behind ?benchmark=1. With the flag it mounts an
// overlay panel, reuses the page's static db/ index + manifest and the session API
// key, runs the ablation matrix over a no-ground-truth question set, and renders only
// success-independent metrics. Without the flag the module is inert — no DOM, no
// fetch, no API call — so the normal chat page is unaffected.
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
} from "../benchmark/smoke.js";
import {
  benchmarkTraceKey,
  benchmarkGapKey,
  benchmarkVariantKey,
} from "../benchmark/sink.js";
import { SessionContext } from "../utils.js";
import { MODEL, MAX_OUTPUT_TOKENS } from "../constants.js";
import type { SearchIndex, Manifest } from "../types.js";
import type { BenchmarkProblem } from "../benchmark/types.js";

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

export async function mountBenchmarkSmoke(): Promise<void> {
  const panel = elFromHtml(`
    <div id="knowdb-smoke" style="position:fixed;inset:0;z-index:9999;background:#fff;display:flex;flex-direction:column;font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#1f2328">
      <div style="display:flex;align-items:center;gap:12px;padding:10px 16px;background:#f6f8fa;border-bottom:1px solid #d0d7de">
        <strong>KnowDB Benchmark — Layer-1 Smoke</strong>
        <span id="smoke-status" style="color:#656d76;font-size:12px"></span>
        <span style="flex:1"></span>
        <button id="smoke-run" style="height:30px;padding:0 16px;border:none;border-radius:6px;background:#0969da;color:#fff;cursor:pointer;font-weight:500">Run smoke benchmark</button>
        <a href="?" style="height:30px;line-height:30px;padding:0 12px;border:1px solid #d0d7de;border-radius:6px;color:#1f2328;text-decoration:none">Exit</a>
      </div>
      <div id="smoke-meta" style="padding:10px 16px;border-bottom:1px solid #d0d7de;color:#656d76;font-size:12px"></div>
      <div id="smoke-downloads" style="display:none;gap:8px;padding:8px 16px;border-bottom:1px solid #d0d7de"></div>
      <pre id="smoke-report" style="flex:1;overflow:auto;margin:0;padding:16px;font-family:SFMono-Regular,Consolas,monospace;font-size:12px;white-space:pre-wrap;line-height:1.6"></pre>
    </div>
  `);
  document.body.appendChild(panel);

  const $ = <T extends HTMLElement>(id: string): T => panel.querySelector(`#${id}`) as T;
  const statusEl = $("smoke-status");
  const metaEl = $("smoke-meta");
  const reportEl = $<HTMLPreElement>("smoke-report");
  const runBtn = $<HTMLButtonElement>("smoke-run");
  const downloadsEl = $<HTMLDivElement>("smoke-downloads");
  const setStatus = (s: string): void => void (statusEl.textContent = s);

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
    `rough estimate ≈ ${fmtTok(est.estTokens.input)} in / ${fmtTok(est.estTokens.output)} out tokens ≈ ${fmtUsd(est.estCostUsd)} ` +
    `(${SMOKE_VARIANTS.join(", ")})`;

  let running: AbortController | null = null;

  const setRunning = (ac: AbortController | null): void => {
    running = ac;
    runBtn.textContent = ac ? "Stop" : "Run smoke benchmark";
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
    const apiKey =
      sessionStorage.getItem("knowdb-api-key") ||
      window.prompt("Anthropic API key (sk-ant-…) — used only for this run, kept in sessionStorage:")?.trim() ||
      "";
    if (!apiKey) {
      setStatus("No API key — run cancelled.");
      return;
    }
    sessionStorage.setItem("knowdb-api-key", apiKey);

    // Cost-preview confirm before the first API request.
    const ok = window.confirm(
      `This sends ${est.units} agent turns to the live API ` +
        `(${est.variantCount} variants × ${est.turnCount} turns).\n\n` +
        `Rough cost ≈ ${fmtUsd(est.estCostUsd)} (≈ ${fmtTok(est.estTokens.input)} in / ${fmtTok(est.estTokens.output)} out tokens, ${MODEL.id}).\n\n` +
        `Proceed?`,
    );
    if (!ok) {
      setStatus("Cancelled at confirm.");
      return;
    }

    const ac = new AbortController();
    setRunning(ac);
    downloadsEl.style.display = "none";
    reportEl.textContent = "";

    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
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
      reportEl.textContent = renderSmokeReportText(report);
      setStatus(ac.signal.aborted ? "Stopped — partial report below." : "Done.");
      showDownloads(runId, report);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(null);
    }
  }

  function showDownloads(runId: string, report: unknown): void {
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
    downloadsEl.style.display = "flex";
  }

  setStatus("Ready.");
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// Inert unless the flag is set.
if (typeof window !== "undefined" && isBenchmarkFlag()) {
  void mountBenchmarkSmoke();
}
