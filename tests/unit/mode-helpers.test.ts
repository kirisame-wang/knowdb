// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { hasFlag, elFromHtml, fmtUsd, fmtTok, nowStamp, wireApiKey, setRunButton } from "../../src/ui/mode-helpers.js";

beforeEach(() => {
  sessionStorage.clear();
  window.location.href = "https://localhost/";
});

describe("mode-helpers", () => {
  it("hasFlag is true only for ?name=1", () => {
    window.location.href = "https://localhost/?compare=1";
    expect(hasFlag("compare")).toBe(true);
    expect(hasFlag("benchmark")).toBe(false);
    window.location.href = "https://localhost/?compare=0";
    expect(hasFlag("compare")).toBe(false);
  });

  it("formats USD and token counts", () => {
    expect(fmtUsd(1.5)).toBe("$1.50");
    expect(fmtTok(1500)).toBe("2k");
    expect(fmtTok(1000)).toBe("1k"); // the >= 1000 boundary
    expect(fmtTok(999)).toBe("999");
  });

  it("elFromHtml returns the first element; nowStamp is filename-safe", () => {
    expect(elFromHtml(`  <div id="a">x</div>  `).id).toBe("a");
    expect(nowStamp()).not.toMatch(/[:.]/);
  });

  it("setRunButton toggles label + colour", () => {
    const btn = document.createElement("button");
    setRunButton(btn, true, "▶ Race");
    expect(btn.textContent).toBe("Stop");
    const runningBg = btn.style.background;
    setRunButton(btn, false, "▶ Race");
    expect(btn.textContent).toBe("▶ Race");
    // running vs idle are colour-distinguished; the exact palette is not asserted.
    expect(btn.style.background).not.toBe(runningBg);
  });
});

describe("mode-helpers wireApiKey", () => {
  it("prefills from the session slot, persists on save, and reads input first", () => {
    sessionStorage.setItem("knowdb-api-key", "stored");
    const input = document.createElement("input");
    const save = document.createElement("button");
    let saved = 0;
    const apiKey = wireApiKey(input, save, () => saved++);

    expect(input.value).toBe("stored"); // prefilled
    expect(apiKey()).toBe("stored"); // falls back to the stored key

    input.value = "  typed  ";
    expect(apiKey()).toBe("typed"); // input wins, trimmed

    save.click();
    expect(sessionStorage.getItem("knowdb-api-key")).toBe("typed"); // persisted (trimmed)
    expect(saved).toBe(1); // onSaved fired
  });

  it("ignores an empty save: keeps the stored key and does not claim saved", () => {
    sessionStorage.setItem("knowdb-api-key", "stored");
    const input = document.createElement("input");
    const save = document.createElement("button");
    let saved = 0;
    wireApiKey(input, save, () => saved++);

    input.value = "   "; // blank
    save.click();
    expect(sessionStorage.getItem("knowdb-api-key")).toBe("stored"); // not cleared
    expect(saved).toBe(0); // onSaved not fired
  });

  it("works without an onSaved callback", () => {
    const input = document.createElement("input");
    const save = document.createElement("button");
    wireApiKey(input, save); // no callback
    input.value = "k";
    expect(() => save.click()).not.toThrow();
    expect(sessionStorage.getItem("knowdb-api-key")).toBe("k");
  });
});
