# KnowDB

*繁體中文版本請見 [README-zh.md](README-zh.md)*

> A map, not an answer.

Most knowledge bases cut documents into chunks, retrieve the nearest matches by vector similarity, and hand the results to an LLM to summarise into an answer. In that pipeline, the agent is passive — it receives whatever the system considers relevant, with no map and no view of the whole.

KnowDB is a prototype exploring a different premise: what if the knowledge layer were designed as a **knowledge database** from the start, letting the agent navigate actively like a reader consulting a document — moving along the heading tree, expanding context on demand, tracking keywords across files?

This repository is **Tier 1** of that idea: the simplest possible implementation that demonstrates the concept. The knowledge base is a folder of plain `.md` files. There is no backend. It runs in a browser.

---

## Core idea

KnowDB has one core premise: **give the agent a map and let it explore actively.**

Not give answers — give clues and let the agent find the answer itself. Everything else in the design follows from this:

**Structure is preserved at ingest, so the map can exist.** When a document enters the system, its heading hierarchy becomes the chunk tree. Each chunk has a stable address (`db/<docId>/<chunkId>.md`) — `01` is the first top-level section, `01-02` its second subsection. The map is not assembled on the fly at query time; it is built when the data comes in.

**The system owns the index, so the map can be trusted.** The agent's job is to query, not to maintain the map's integrity. The ingest pipeline produces the search index and heading trees. The agent never writes to these — it trusts the map, rather than guessing and correcting as it goes.

**The query API follows the document tree, so exploration can happen.** The agent starts with the smallest useful context and expands only as needed — drilling down the heading hierarchy, climbing back up, or jumping across documents by keyword. When to go deeper is the agent's decision, not the system's.

---

## This prototype

The Tier 1 implementation deliberately uses no infrastructure beyond the filesystem:

- `npm run ingest <file.md>` parses headings and writes chunk files to `db/`
- `_search_index.json` is loaded once by the browser; all search is client-side
- The UI is two panels: document navigator on the left, agent Q&A on the right
- The agent has seven tools: `get_instructions`, `list_docs`, `read_index`, `search`, `read_chunk`, `read_chunks`, `parent`
- No backend. Deployable to any static host.

### Query API

The seven tools divide along the two navigation axes:

| Tool | Axis | Purpose |
|------|------|---------|
| `get_instructions` | — | Load navigation instructions at session start |
| `list_docs` | — | Discover all available documents |
| `read_index` | Vertical | See the full heading tree of a document |
| `read_chunk` | Vertical | Read the full content of a specific chunk by its stable address |
| `read_chunks` | Vertical | Fetch previews of multiple chunks in one call — for progressive exploration before deciding to expand |
| `parent` | Vertical | Move up to the parent section |
| `search` | Horizontal | Find chunks across all documents by keyword |

The pattern for a well-behaved agent: orient with `list_docs` and `read_index`, locate with `search`, preview candidates with `read_chunks`, expand with `read_chunk`, zoom out with `parent`.

---

## Try it yourself

Clone the repo first:

```bash
git clone https://github.com/kirisame-wang/knowdb.git
cd knowdb
npm install
```

Replace the files in `raw/` with your own Markdown files, then rebuild the knowledge base:

```bash
rm -rf db/
npm run ingest raw/
```

Then choose how to query it:

**Option A — Browser UI** (requires an Anthropic API key)

```bash
npm run dev   # open http://localhost:5173
```

Paste your API key into the UI and ask questions. Build for static deployment with `npm run build`.

**Option B — Local coding agent** (no API key, no browser)

Reference `SKILL.md` in your prompt and the agent navigates `db/` directly using `bash` and `grep`. See [Using with a local coding agent](#using-with-a-local-coding-agent) for details.

---

## Using with a local coding agent

`SKILL.md` in the repo root is a skill file for local coding agents (e.g. Claude Code). It describes how to query the knowledge base using `bash` and `grep` — no browser, no API key required.

**Reference inline** — mention the file directly in your prompt and the agent will read it on the spot:

```
@SKILL.md what is the revenue for 2023?
```

**Register as a persistent skill** — the agent loads the instructions automatically on every invocation:

The following commands target **Claude Code**. Other agents may use a different skill directory.

<details>
<summary>macOS / Linux</summary>

```bash
mkdir -p .claude/skills/knowdb-local-search
cp SKILL.md .claude/skills/knowdb-local-search/Skill.md
```

</details>

<details>
<summary>Windows (PowerShell)</summary>

```powershell
New-Item -ItemType Directory -Force .claude\skills\knowdb-local-search
Copy-Item SKILL.md .claude\skills\knowdb-local-search\Skill.md
```

</details>

<details>
<summary>Windows (CMD)</summary>

```cmd
mkdir .claude\skills\knowdb-local-search
copy SKILL.md .claude\skills\knowdb-local-search\Skill.md
```

</details>

Either way, the agent follows the same four-step workflow — discover → orient → search → read — to answer questions about documents ingested into `db/`.

---

## Why structure matters

Most retrieval systems treat documents as bags of chunks. The heading hierarchy — the structure an author spent time creating — is discarded at ingest and has to be guessed back at query time by the LLM.

KnowDB keeps that structure. A chunk at `db/doc/01-02-03.md` encodes not just its content but its position: it is the third subsection of the second section of a document. An agent reading that chunk knows exactly where it sits, what came before, and where to look next. It does not have to infer the document's shape from isolated passages.

This matters most for technical documentation, design specifications, and research papers — documents where the heading structure reflects deliberate organisation, not arbitrary pagination.

KnowDB also makes a different assumption from the start. A vector database expects the right document to exist and to be reachable in one shot — it returns the top-k nearest chunks and expects the answer to be among them. KnowDB makes no such assumption. It provides an index as a set of clues and lets the agent decide where to go. The index is not a filter for correct answers; it is a map of what exists.

This changes the failure mode. When a vector search misses, it fails silently — the agent receives plausible-looking chunks and has no signal that the right content was never retrieved. When KnowDB navigation comes up empty, the agent knows: the gap is explicit, not hidden.

KnowDB inverts the responsibility model of traditional RAG:

|  | Traditional RAG | KnowDB |
|--|-----------------|--------|
| **Semantic layer** | Embedding model | The agent itself |
| **Structure layer** | LLM infers at query time | System maintains at ingest |
| **Noise source** | Uneven vector density | Keyword + excerpt; agent filters |

Traditional RAG asks the embedding model to handle semantics and the LLM to reconstruct structure — neither is what they do best. KnowDB assigns each job to the right party: the system owns structure, the agent owns meaning. An agent is already a semantic matching layer; it can translate a natural-language question into keywords. What it cannot do reliably is infer document shape from isolated chunks. KnowDB solves that problem at ingest, so the agent never has to.

---

## Two axes of navigation

The query API exposes two complementary ways to move through the knowledge base:

**Vertical navigation** follows the document's own structure. An agent starts with `read_index` to see the full heading tree of a document, drills into a section with `read_chunk`, and climbs back up with `parent`. The document's hierarchy — the structure its author gave it — is the map.

**Horizontal navigation** crosses document boundaries via keyword search. `search` returns matching chunks from any document in the knowledge base. These cross-document links are implicit: they are not pre-defined edges in a graph, but connections that emerge from shared concepts at query time. An agent decides at each step whether to go deeper into the current document or jump sideways to a related one.

Together, vertical and horizontal navigation let an agent explore a knowledge base the way a careful reader would: following the structure when it is clear, searching when the answer might be elsewhere.

---

## Expansion roadmap

The three tiers share the same workflow — hierarchical search on demand — and differ only in the storage layer underneath.

Tier 1 validates the workflow: can an agent navigate a document corpus using its natural heading hierarchy and keyword search to find what it needs, without a backend, without embeddings, without a graph database? If the answer is yes, the workflow is sound.

Tier 2 and Tier 3 extend that validated workflow to new constraints: concurrent users, large corpora, enterprise-scale retrieval. The database design follows the workflow — not the other way around. Before moving to the next tier, the question is always: does existing infrastructure already satisfy this tier's requirements?

| Tier | Storage | Scale | Status |
|------|---------|-------|--------|
| **1 — Filesystem** | Plain `.md` files + JSON index | Tens to hundreds of documents | This prototype |
| **2 — Embedded DB** | SQLite FTS5 (sqlite-wasm) | Thousands of documents | Planned |
| **3 — Enterprise** | TBD | Hundreds of thousands and beyond | Future |

Detailed design and specification for Tier 2 and Tier 3 will be published separately.

---

## Contributing

Issues and pull requests are welcome.

A few things that would be especially useful:

- **Bug reports** — if ingestion produces unexpected chunk splits or the agent behaves oddly, a minimal reproduction is very helpful
- **Ingest edge cases** — Markdown structures that break the heading parser
- **Agent tool feedback** — observations on how the agent navigates, where it gets stuck, or tool designs that would improve retrieval
- **Ideas toward Tier 2** — thoughts on the SQLite FTS5 path or the embedded DB query API

For larger changes, opening an issue to discuss the direction first is appreciated before writing code.
