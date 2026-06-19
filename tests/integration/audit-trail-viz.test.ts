// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "../../src/audit-trail-viz.js";
import type { TraceCollectorEvent } from "../../src/traces.js";

// Minimal subscribe-only collector stub (mirrors BrowserTraceCollector's hook).
class FakeCollector {
  private subs = new Set<(e: TraceCollectorEvent) => void>();
  subscribe(cb: (e: TraceCollectorEvent) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  emit(e: TraceCollectorEvent): void {
    for (const cb of this.subs) cb(e);
  }
}

const qStart: TraceCollectorEvent = {
  kind: "query_start",
  query_id: "q1",
  user_question: "Q",
  started_at: "2026-06-02T00:00:00.000Z",
};
const tc = (ordinal: number, tool: string, input: Record<string, unknown>): TraceCollectorEvent => ({
  kind: "tool_call_added",
  query_id: "q1",
  event: { ordinal, tool, input, output_summary: "…", duration_ms: 1, timestamp: "2026-06-02T00:00:00.000Z" },
});
const round = (i: number, o: number): TraceCollectorEvent => ({
  kind: "api_round_added",
  query_id: "q1",
  round: { ordinal: 1, input_tokens: i, output_tokens: o, duration_ms: 5 },
});

const fpRoot = (): HTMLElement => document.getElementById("fp-root")!;
const node = (id: string): HTMLElement => document.querySelector<HTMLElement>(`.chunk-item[data-id="${id}"]`)!;

beforeEach(() => {
  // Mirror the real doc-tree structure (renderDocTree): collapsed .chunk-list by default.
  document.body.innerHTML = `
    <div id="doc-tree">
      <div class="doc-item">
        <div class="doc-label"><span>doc aaa</span></div>
        <div class="chunk-list">
          <div class="chunk-item" data-id="aaa/00">00</div>
          <div class="chunk-item" data-id="aaa/01">01</div>
        </div>
      </div>
    </div>
    <div id="fp-root"></div>`;
});

describe("audit-trail-viz DOM smoke", () => {
  it("renders footprint entries and highlights the current tree node", () => {
    const c = new FakeCollector();
    mount(c, fpRoot());
    c.emit(qStart);
    c.emit(tc(1, "read_chunk", { id: "aaa/01" }));

    const items = fpRoot().querySelectorAll(".knowdb-footprint li");
    expect(items).toHaveLength(1);
    expect(items[0]!.querySelector(".tool")!.textContent).toBe("read_chunk");
    expect(items[0]!.querySelector(".summary")!.textContent).toBe("aaa/01");

    expect(node("aaa/01").classList.contains("knowdb-current-node")).toBe(true);
    expect(node("aaa/00").classList.contains("knowdb-current-node")).toBe(false);
    // auto-expands the containing doc so the highlight is visible
    expect(document.querySelector(".chunk-list")!.classList.contains("open")).toBe(true);
    expect(document.querySelector(".doc-label")!.classList.contains("open")).toBe(true);
  });

  it("token ⓘ title reflects accumulated tokens; no standing token text", () => {
    const c = new FakeCollector();
    mount(c, fpRoot());
    c.emit(qStart);
    c.emit(round(100, 30));
    c.emit(round(80, 25));

    const info = fpRoot().querySelector<HTMLElement>(".knowdb-token-info")!;
    expect(info.title).toBe("this query — tokens in 180 / out 55"); // scoped to the current query
    expect(info.textContent).not.toMatch(/\d/); // hover-only: no standing token numbers (glyph not asserted)
  });

  it("with pricing, the ⓘ title adds an estimated cost line", () => {
    const c = new FakeCollector();
    mount(c, fpRoot(), undefined, { inputPerMTok: 1, outputPerMTok: 5 });
    c.emit(qStart);
    c.emit(round(1_000_000, 200_000)); // $1.00 in + $1.00 out = $2.0000

    const info = fpRoot().querySelector<HTMLElement>(".knowdb-token-info")!;
    expect(info.title).toBe("this query — tokens in 1000000 / out 200000\nest. cost — $2.0000");
  });

  it("clicking a footprint entry jumps the highlight and opens the preview", () => {
    const c = new FakeCollector();
    const selected: string[] = [];
    mount(c, fpRoot(), (id) => selected.push(id)); // onSelect injected (demo's selectChunk)
    c.emit(qStart);
    c.emit(tc(1, "read_chunk", { id: "aaa/00" }));
    c.emit(tc(2, "read_chunk", { id: "aaa/01" })); // current → aaa/01
    selected.length = 0; // ignore navigation auto-previews; isolate the click

    fpRoot().querySelector<HTMLElement>('.knowdb-footprint li[data-ordinal="1"]')!.click();

    expect(node("aaa/00").classList.contains("knowdb-current-node")).toBe(true);
    expect(node("aaa/01").classList.contains("knowdb-current-node")).toBe(false);
    expect(selected).toEqual(["aaa/00"]); // also navigates / opens preview
  });

  it("auto-loads the preview for the current node during navigation, no click", () => {
    const c = new FakeCollector();
    const selected: string[] = [];
    mount(c, fpRoot(), (id) => selected.push(id));
    c.emit(qStart);
    c.emit(tc(1, "read_chunk", { id: "aaa/00" }));
    c.emit(tc(2, "search", { keyword: "x" })); // no chunk_id → current node unchanged → no preview
    c.emit(tc(3, "read_chunk", { id: "aaa/01" }));

    // preview follows each read-class step; search (no chunk) does not re-trigger
    expect(selected).toEqual(["aaa/00", "aaa/01"]);
  });

  it("after teardown, further events do not change the DOM", () => {
    const c = new FakeCollector();
    const unmount = mount(c, fpRoot());
    c.emit(qStart);
    c.emit(tc(1, "read_chunk", { id: "aaa/01" }));
    unmount();
    c.emit(tc(2, "read_chunk", { id: "aaa/00" }));

    expect(fpRoot().querySelectorAll(".knowdb-footprint li")).toHaveLength(1);
  });
});
