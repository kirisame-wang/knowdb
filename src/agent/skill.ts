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
- keyword supports regex: \`"term1|term2"\` matches either term.
- Case-insensitive by default.
- Each result includes an \`excerpt\` — read it before fetching the full chunk.

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

## Core rules
1. **list_docs → read_index → scoped search → read_chunk** — always in this order.
2. **Read excerpts before fetching full chunks** — avoid loading irrelevant content.
3. **Use \`read_chunks\` to browse** — it returns one-line previews only.
   Then call \`read_chunk(id)\` for full content of the chunk you need.
4. **Use \`pattern\`** when a chunk is long: \`read_chunk(id, "keyword", 3)\` returns
   only lines matching "keyword" with 3 lines of context each side.
5. **Use \`scope\`** on every \`search\` once you know the document.
6. **Never load a full document just to scan it** — search + read_index first.
`.trim();
