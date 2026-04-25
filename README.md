# KnowDB

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
| **3 — Enterprise** | Elasticsearch / PostgreSQL + graph layer | Hundreds of thousands and beyond | Future |

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

# KnowDB

大多數知識庫圍繞著檢索 pipeline 構建——文件輸入、向量輸出，再把幾個 chunk 交給 LLM 整理。KnowDB 是一個探索不同前提的原型：如果知識層從一開始就以 **文件資料庫** 的形態設計，專為 Agent 的存取模式而生，會是什麼樣子？

目標不是 RAG pipeline，也不是 LLM wiki。而是一個資料庫：文件以強制的結構進入系統，索引由系統維護（而非 LLM），查詢 API 則設計來對應 Agent 實際導覽知識的方式——沿著文件樹移動、按需擴展脈絡、跨段落跳轉。

這個 repository 是這個想法的 **Tier 1**：能夠展示概念的最簡實作。知識庫是一個純 `.md` 檔案的資料夾，沒有後端，在瀏覽器中執行。

---

## 核心理念

為 Agent 設計的文件資料庫，有三個特性使其有別於一般知識庫：

**結構在 ingest 時保留，而非在查詢時重建。** 文件進入系統時，其標題層級即成為 chunk 樹。每個 chunk 有穩定的位址（`db/<docId>/<chunkId>.md`），編碼了它在樹中的位置：`01` 是第一個頂層段落，`01-02` 是其第二個子段落，`01-02-03` 再深一層。

**系統擁有索引。** Agent 的職責是查詢，而非維護索引完整性。Ingest pipeline 產生 `_search_index.json` 與 `_index.md` 標題樹，Agent 不寫入這些檔案。

**查詢 API 沿著文件樹設計。** Agent 透過垂直移動（parent、expand）與水平跳轉（search、related）來導覽。它從最小的有用 context 開始，按需擴展——不是因為系統決定了 chunk 大小，而是因為 Agent 判斷需要更多資訊。

---

## 此原型

Tier 1 實作刻意不使用任何檔案系統以外的基礎設施：

- `npm run ingest <file.md>` 解析標題，將 chunk 檔案寫入 `db/`
- `_search_index.json` 由瀏覽器一次性載入，所有搜尋在用戶端執行
- UI 分為兩個面板：左側文件導覽，右側 Agent 問答
- Agent 有七個工具：`get_instructions`、`list_docs`、`read_index`、`search`、`read_chunk`、`read_chunks`、`parent`
- 無後端，可部署至任何靜態主機

---

## 三層架構

此設計預計跨越三個層級，共享相同的概念模型——chunk 樹、結構索引、Agent 原生查詢 API——而底層的儲存技術逐層替換。

| 層級 | 儲存技術 | 規模 | 狀態 |
|------|---------|------|------|
| **1 — 檔案系統** | 純 `.md` 檔案 + JSON 索引 | 數十至數百份文件 | 此原型 |
| **2 — 嵌入式 DB** | SQLite FTS5（sqlite-wasm） | 數千份文件 | 規劃中 |
| **3 — 企業級** | Elasticsearch / PostgreSQL + 圖層 | 數十萬份文件以上 | 未來規劃 |

Tier 2 與 Tier 3 的詳細設計與規格文件將另行公開。

---

## 自行試用

```bash
git clone https://github.com/kirisame-wang/knowdb.git
cd knowdb
npm install
npm run ingest raw/   # 攝入隨附的範例文件
npm run dev           # 開啟 http://localhost:5173
```

在 UI 中貼上 Anthropic API 金鑰，即可對已攝入的文件提問。

部署建置：`npm run build`——將 `dist/` 複製到任何靜態主機。API 金鑰僅存於 `sessionStorage`，不會離開瀏覽器。
