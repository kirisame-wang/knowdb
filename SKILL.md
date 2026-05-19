---
name: knowdb-local-search
description: Step-by-step guide for querying a KnowDB knowledge base using bash and grep. Use when answering questions from documents ingested into db/.
---

# KnowDB — Local Search Guide (bash / grep)

For use by local coding agents with filesystem access.
The `db/` directory is the knowledge base. All commands below assume the repo root as working directory.

---

## Step 0 — Session setup

At session start — before your first search — unconditionally generate a
stable id and write it to `.session_id` at the repo root (overwrite; a
new session gets a new id):

```bash
date -u +%Y%m%dT%H%M%SZ-$RANDOM > .session_id
```

---

## Step 1 — Discover available documents

```bash
cat db/_manifest.json
```

Returns `{ "<doc_id>": { "originalFilename": "...", "title": "..." }, ... }`.
Each `doc_id` is an 8-hex string that maps to a subdirectory under `db/`.
`title` is the human-readable document name — cite it (not the filename or
doc_id) when referring to a document.

---

## Step 2 — Orient within a document

```bash
cat db/<doc_id>/_index.md
```

Shows the full heading tree: section titles and their chunk IDs.
Read this before searching to identify which chunks are relevant.

`_index.md` is also your **breadcrumb**: it maps every chunk ID to its
heading title and shows the full root→chunk path. After a grep hit, read
`_index.md` to recover where the chunk sits — its title, parent heading,
and siblings — instead of `cat`-ing parent chunks just to orient.

If unsure which document to look in, scan all heading trees at once:

```bash
grep -ril "<keyword>" db/*/_index.md
```

This is fast and low-noise — headings only, no body content.

---

## Step 3 — Targeted search

Search within one document (recommended):

```bash
grep -rin "<keyword>" db/<doc_id>/
```

Search across all documents:

```bash
grep -rin "<keyword>" db/ --include="*.md" --exclude="_index.md"
```

Useful flags:
- `-r` recursive, `-i` case-insensitive, `-n` show line numbers
- `-l` list matching files only (for a quick overview)
- `-P` enable Perl-compatible regex: `grep -rinP "term1|term2" db/<doc_id>/`

Each result shows the file path (`<doc_id>/<chunk_id>.md`) and the matching line.
Read the surrounding lines before fetching the full chunk.

---

## Step 4 — Read minimally

| Need | Command |
|---|---|
| Browse chunk IDs in a document | `ls db/<doc_id>/` |
| Preview first line of each chunk | `for f in db/<doc_id>/*.md; do echo "$f:"; head -1 "$f"; done` |
| Read one chunk in full | `cat db/<doc_id>/<chunk_id>.md` |
| Read only matching lines with context | `grep -in -C 3 "<pattern>" db/<doc_id>/<chunk_id>.md` |
| Find parent chunk | strip the last `-XX` segment: `01-02-03` → parent is `01-02` |
| Read parent chunk | `cat db/<doc_id>/<parent_id>.md` |
| Read siblings | `ls db/<doc_id>/ \| grep "^<parent_id>-"` |
| Read the whole document (chunked nav not enough) | `cat $(ls db/<doc_id>/*.md \| grep -v _index.md \| sort)` — body-only concat in chunk-ID order; **no headings** (unlike browser `reconstruct_document`) — read `_index.md` alongside for the heading tree |

---

## Step 5 — Lateral cross-document jump

KnowDB has no explicit `[[ref]]` registry — related material is found by
shared terms. After reading a chunk that matters, take its salient terms
and grep them across the *other* documents:

```bash
grep -rinlP "<term1>|<term2>" db/ --include="*.md" --exclude="_index.md" \
  | grep -v "db/<current_doc_id>/"
```

This surfaces connected material elsewhere in the knowledge base that a
single-document (scoped) search would miss.

---

## Core rules

1. **manifest → `_index.md` → scoped grep → `cat`** — always in this order.
2. **Read grep output before fetching full chunks** — the matching line is often enough.
3. **Use `-C` for context** when a chunk is long: `grep -in -C 3 "keyword" <file>` returns matching lines with 3 lines of context each side.
4. **Scope every search** to a `doc_id` subdirectory once you know the target document.
5. **Never `cat` a full document just to scan it** — grep + `_index.md` first. Read the whole document only when you genuinely need it as continuous text.
6. **Chunk ID encodes position in the heading tree**: `01` = first top-level section, `01-02` = its second subsection, `01-02-03` = one level deeper. Use this to navigate without reading files.
7. **`_index.md` is the breadcrumb** — read it to learn a chunk's title, parent and siblings instead of `cat`-ing parent chunks to orient.
8. **Follow lateral links**: after reading a strong chunk, grep its key terms across the other documents (Step 5) — it surfaces implicit cross-document connections a scoped search misses.
