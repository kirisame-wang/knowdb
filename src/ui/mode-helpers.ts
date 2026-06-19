// Shared helpers for the gated full-screen modes (benchmark / compare). DOM and
// sessionStorage only — no SDK, no domain logic — so both build the same shell
// from one source.

/** True when ?<name>=1 is in the URL. */
export function hasFlag(name: string): boolean {
  return new URLSearchParams(window.location.search).get(name) === "1";
}

/** First element of a trimmed HTML string. */
export function elFromHtml(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

export const fmtUsd = (x: number): string => `$${x.toFixed(2)}`;
export const fmtTok = (x: number): string => (x >= 1000 ? `${(x / 1000).toFixed(0)}k` : String(x));

/** Filename-safe timestamp for a run id. */
export function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

const API_KEY_SLOT = "knowdb-api-key";

/** Wire an api-key input to the shared session-storage slot: prefill it, persist
 *  the trimmed value on save (firing onSaved), and return an accessor that reads
 *  the input, falling back to the stored key. */
export function wireApiKey(
  input: HTMLInputElement,
  saveBtn: HTMLElement,
  onSaved?: () => void,
): () => string {
  input.value = sessionStorage.getItem(API_KEY_SLOT) ?? "";
  saveBtn.addEventListener("click", () => {
    const key = input.value.trim();
    if (!key) return; // ignore an empty save: don't clear the slot or claim "saved"
    sessionStorage.setItem(API_KEY_SLOT, key);
    onSaved?.();
  });
  return () => input.value.trim() || sessionStorage.getItem(API_KEY_SLOT) || "";
}

/** Toggle a run button between idle (its own label, blue) and running (Stop, red). */
export function setRunButton(btn: HTMLElement, running: boolean, idleLabel: string): void {
  btn.textContent = running ? "Stop" : idleLabel;
  btn.style.background = running ? "#cf222e" : "#0969da";
}
