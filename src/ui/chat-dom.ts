// Shared DOM builders for the chat surface, used by the main chat and the compare
// lanes so both render identical .chat-bubble / .tool-trace markup. Styling lives
// in index.html.

/** A message bubble. role drives side + colour via .chat-bubble.{role}. */
export function buildBubble(role: "user" | "assistant", text: string): HTMLElement {
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;
  return bubble;
}

/** A collapsible tool-call trace: a summary line + an Input/Result body. `result`
 *  is rendered verbatim — the caller truncates it if needed. `open` expands it. */
export function buildToolTrace(
  toolName: string,
  input: unknown,
  result: string,
  opts: { open?: boolean } = {},
): HTMLElement {
  const details = document.createElement("details");
  details.className = "tool-trace";
  if (opts.open) details.open = true;
  const summary = document.createElement("summary");
  const inputStr = JSON.stringify(input);
  summary.textContent = `🔧 ${toolName}(${inputStr.length > 50 ? inputStr.slice(0, 50) + "…" : inputStr})`;
  const body = document.createElement("div");
  body.className = "tool-trace-body";
  body.textContent = `Input:\n${JSON.stringify(input, null, 2)}\n\nResult:\n${result}`;
  details.append(summary, body);
  return details;
}
