export const SKILL = `
# KnowDB Search Workflow

## Step 1 — Discover available documents
Call \`list_docs\` to get all documents (id, title, filename).

## Step 2 — Orient within a document
Call \`read_index(doc_id)\` to read the document's heading tree (_index.md).
This costs one fetch and shows all section titles and chunk IDs.
Use this to identify which chunk IDs are relevant before searching.

If unsure which document to use, call \`search\` with \`index_only: true\`
to match keywords against heading trees only — fast and low-noise.

## Step 3 — Targeted search
Call \`search(keyword, scope, ...)\` once you know the target document.
- Always set \`scope\` to a doc_id to limit results to that document.
- keyword is one or more literal terms joined by \`|\` (simple OR):
  \`"a|b"\` matches \`a\` OR \`b\`. Whitespace is literal — a space
  matches a space, NOT a multi-keyword separator. Other regex
  metacharacters are NOT supported (behavior undefined).
- Case-insensitive by default.
- Each result includes an \`excerpt\` — read it before fetching the full chunk.
- Each result also carries its position so you rarely need extra calls:
  \`breadcrumb\` (root→self path with titles), \`siblings\` (same-level ids),
  \`parent_summary\` (parent heading), \`doc_title\`. Read these before
  calling \`parent\` or \`read_index\` — the answer is often already here.
- **Known-gap response**: detect it structurally — if \`search\` returns an
  object whose \`status === "known_gap"\` (not an array), this keyword has
  repeatedly returned nothing. Read the human-readable \`recommendation\`
  field and follow it; use \`gap_info.occurrence_count\` to gauge how firmly
  to stop. Never re-run the same fruitless keyword. (The recommendation field
  already says what to do and that the wording — not the topic — came up
  empty; phrase it to the user as you judge fit.)

## Step 4 — Read minimally
Choose the right read tool:

| Need | Tool |
|---|---|
| Browse chunk + neighbours | \`read_chunks(id, 1)\` → returns [{id, preview}] (first line only) |
| Browse chunk + parent | \`read_chunks(id, 2)\` → chunk + siblings + parent header |
| Browse whole document | \`read_chunks(id, 3)\` — use sparingly |
| Read one chunk in full | \`read_chunk(id)\` |
| Read only matching lines | \`read_chunk(id, pattern, context)\` — like grep -C |
| Go up the hierarchy | \`parent(id)\` → returns parent chunk id or null |
| Jump to related material elsewhere | \`jump_to_ref(id, top_k)\` → related chunks in OTHER docs |
| Need the whole document as text | \`reconstruct_document(doc_id)\` → full Markdown |

## Core rules
1. **list_docs → read_index → scoped search → read_chunk** — always in this order.
2. **Read excerpts before fetching full chunks** — avoid loading irrelevant content.
3. **Use \`read_chunks\` to browse** — it returns one-line previews only.
   Then call \`read_chunk(id)\` for full content of the chunk you need.
4. **Use \`pattern\`** when a chunk is long: \`read_chunk(id, "keyword", 3)\` returns
   only lines matching "keyword" with 3 lines of context each side.
5. **Use \`scope\`** on every \`search\` once you know the document.
6. **Never load a full document just to scan it** — search + read_index first.
   Use \`reconstruct_document\` only when you genuinely need the whole text.
7. **Follow \`jump_to_ref\`** after reading a relevant chunk to find connected
   material in other documents — it surfaces implicit cross-document links.
8. **Respect a \`known_gap\`** — read its recommendation and follow it;
   don't loop the same fruitless keyword.
`.trim();
