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
| Read one chunk | \`read_chunk(id)\` |
| Read only matching lines | \`read_chunk(id, grep, context)\` — like grep -C |
| Read chunk + neighbours | \`read_chunks(id, 1)\` → chunk + siblings |
| Read chunk + parent | \`read_chunks(id, 2)\` → chunk + siblings + parent header |
| Read whole document | \`read_chunks(id, 3)\` — use sparingly |
| Go up the hierarchy | \`parent(id)\` → returns parent chunk id or null |

## Core rules
1. **list_docs → read_index → scoped search → read_chunk** — always in this order.
2. **Read excerpts before fetching full chunks** — avoid loading irrelevant content.
3. **Use \`grep\`** when a chunk is long: \`read_chunk(id, "keyword", 3)\` returns
   only lines matching "keyword" with 3 lines of context each side.
4. **Use \`scope\`** on every \`search\` once you know the document.
5. **Start at level 1** for \`read_chunks\`; escalate to level 2/3 only if needed.
6. **Never load a full document just to scan it** — search + read_index first.
`.trim();
