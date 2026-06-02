// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "../../src/ui/audit-trail-viz.js";
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

describe("audit-trail-viz DOM smoke (spec §5)", () => {
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

  it("token ⓘ title reflects accumulated tokens; no standing token text (U6)", () => {
    const c = new FakeCollector();
    mount(c, fpRoot());
    c.emit(qStart);
    c.emit(round(100, 30));
    c.emit(round(80, 25));

    const info = fpRoot().querySelector<HTMLElement>(".knowdb-token-info")!;
    expect(info.title).toBe("tokens — in 180 / out 55");
    expect(info.textContent).toBe("ⓘ"); // 只有圖示，無常駐 token 文字
  });

  it("clicking a footprint entry jumps the highlight and opens the preview (C4)", () => {
    const c = new FakeCollector();
    const selected: string[] = [];
    mount(c, fpRoot(), (id) => selected.push(id)); // onSelect injected (demo's selectChunk)
    c.emit(qStart);
    c.emit(tc(1, "read_chunk", { id: "aaa/00" }));
    c.emit(tc(2, "read_chunk", { id: "aaa/01" })); // current → aaa/01

    fpRoot().querySelector<HTMLElement>('.knowdb-footprint li[data-ordinal="1"]')!.click();

    expect(node("aaa/00").classList.contains("knowdb-current-node")).toBe(true);
    expect(node("aaa/01").classList.contains("knowdb-current-node")).toBe(false);
    expect(selected).toEqual(["aaa/00"]); // also navigates / opens preview
  });

  it("after teardown, further events do not change the DOM (U8)", () => {
    const c = new FakeCollector();
    const unmount = mount(c, fpRoot());
    c.emit(qStart);
    c.emit(tc(1, "read_chunk", { id: "aaa/01" }));
    unmount();
    c.emit(tc(2, "read_chunk", { id: "aaa/00" }));

    expect(fpRoot().querySelectorAll(".knowdb-footprint li")).toHaveLength(1);
  });
});
