import type { QueryTrace } from "../types.js";

// B3 — pure classification from `tool_calls`. No ground truth needed; this is
// the *actual* path the agent took. A query is cross_doc if it located chunks
// in more than one document, or used jump_to_ref (a cross-doc edge by nature).
//
// Locators are the calls that pin a position in the map. search / list_docs are
// discovery, not location, so they never count toward the doc set.

const LOCATORS = new Set(["read_chunk", "read_chunks", "read_index", "parent", "jump_to_ref"]);

function docIdOf(input: Record<string, unknown>): string | undefined {
  const raw = input["id"] ?? input["doc_id"];
  if (typeof raw !== "string") return undefined;
  return raw.split("/")[0];
}

export function classifyQuery(trace: QueryTrace): "within_doc" | "cross_doc" {
  const docIds = new Set<string>();
  let usedJump = false;
  for (const c of trace.tool_calls) {
    if (c.tool === "jump_to_ref") usedJump = true;
    if (!LOCATORS.has(c.tool)) continue;
    const docId = docIdOf(c.input);
    if (docId) docIds.add(docId);
  }
  return docIds.size > 1 || usedJump ? "cross_doc" : "within_doc";
}
