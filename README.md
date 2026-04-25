# KnowDB

> 繁體中文版本請見 [README-zh.md](README-zh.md)

Most knowledge bases are built around a retrieval pipeline — documents go in, embeddings come out, and the LLM is handed a handful of chunks to summarise. KnowDB is a prototype exploring a different premise: what if the knowledge layer were a **document database** designed from the start for agent access patterns?

The goal is not a RAG pipeline or an LLM wiki. It is a database where documents are ingested with enforced structure, the index is maintained by the system (not the LLM), and the query API is designed around how an agent actually navigates knowledge — following the document tree, expanding context on demand, jumping across related sections.

This repository is **Tier 1** of that idea: the simplest possible implementation that demonstrates the concept. The knowledge base is a folder of plain `.md` files. There is no backend. It runs in a browser.

---

## Core idea

A document database designed for agents has three properties that distinguish it from a knowledge base:

**Structure is preserved at ingest, not reconstructed at query time.** When a document enters the system, its heading hierarchy becomes the chunk tree. Each chunk has a stable address (`db/<docId>/<chunkId>.md`) that encodes its position in the tree: `01` is the first top-level section, `01-02` its second subsection, `01-02-03` one level deeper.

**The system owns the index.** The agent's job is to query, not to maintain index integrity. The ingest pipeline produces `_search_index.json` and `_index.md` heading trees. The agent never writes to these.

**The query API follows the document tree.** An agent navigates by moving vertically (parent, expand) and horizontally (search, related). It starts with the smallest useful context and expands only as needed — not because the system decided the chunk size, but because the agent decided it needed more.

---

## This prototype

The Tier 1 implementation deliberately uses no infrastructure beyond the filesystem:

- `npm run ingest <file.md>` parses headings and writes chunk files to `db/`
- `_search_index.json` is loaded once by the browser; all search is client-side
- The UI is two panels: document navigator on the left, agent Q&A on the right
- The agent has seven tools: `get_instructions`, `list_docs`, `read_index`, `search`, `read_chunk`, `read_chunks`, `parent`
- No backend. Deployable to any static host.

---

## Three-tier architecture

The design is intended to scale across three tiers that share the same conceptual model — chunk tree, structural index, agent-native query API — while swapping the storage layer underneath.

| Tier | Storage | Scale | Status |
|------|---------|-------|--------|
| **1 — Filesystem** | Plain `.md` files + JSON index | Tens to hundreds of documents | This prototype |
| **2 — Embedded DB** | SQLite FTS5 (sqlite-wasm) | Thousands of documents | Planned |
| **3 — Enterprise** | TBD | Hundreds of thousands and beyond | Future |

Detailed design and specification for Tier 2 and Tier 3 will be published separately.

---

## Try it yourself

```bash
git clone https://github.com/kirisame-wang/knowdb.git
cd knowdb
npm install
npm run ingest raw/   # ingest the included sample documents
npm run dev           # open http://localhost:5173
```

Paste your Anthropic API key into the UI and ask questions about the ingested documents.

Build for deployment: `npm run build` — copy `dist/` to any static host. The API key stays in `sessionStorage` and never leaves the browser.

---

## Using with a local coding agent

`SKILL.md` in the repo root is a skill file for local coding agents (e.g. Claude Code). It describes how to query the knowledge base using `bash` and `grep` — no browser, no API key required.

If your agent supports skills, point it at this file:

```bash
# Claude Code — register as a project skill
cp SKILL.md .claude/skills/knowdb-local-search.md
```

Once loaded, the agent can answer questions about any documents ingested into `db/` by following the skill's four-step workflow: discover → orient → search → read.

---

## Contributing

Issues and pull requests are welcome.

A few things that would be especially useful:

- **Bug reports** — if ingestion produces unexpected chunk splits or the agent behaves oddly, a minimal reproduction is very helpful
- **Ingest edge cases** — Markdown structures that break the heading parser
- **Agent tool feedback** — observations on how the agent navigates, where it gets stuck, or tool designs that would improve retrieval
- **Ideas toward Tier 2** — thoughts on the SQLite FTS5 path or the embedded DB query API

For larger changes, opening an issue to discuss the direction first is appreciated before writing code.
