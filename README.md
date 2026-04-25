# KnowDB

A minimal, browser-based knowledge base explorer. Ingest Markdown files into a flat chunk store on disk, then browse and search them through a two-panel web UI. The right panel runs an AI agent (Claude Haiku via the Anthropic API) that queries the knowledge base using tool use.

No backend server is required. The app is a fully static site.

---

## Quick start

```bash
npm install

# Ingest a single file or an entire directory
npm run ingest raw/my-notes.md
npm run ingest raw/

# Start the dev server
npm run dev
```

Open the browser, paste your Anthropic API key into the key field in the UI, and start querying.

---

## How ingestion works

`npm run ingest <path>` (`scripts/ingest.ts`) parses heading hierarchy from each Markdown file and splits content into chunks. Output is written to `db/`.

**File layout**

```
db/
  <docId>/
    _meta.json          # title, source path, chunk count
    <chunkId>.md        # one file per chunk
  _manifest.json        # list of all docIds + titles
  _search_index.json    # flat index of all chunks for search
```

**ID conventions**

| ID | Derivation |
|----|-----------|
| `docId` | `sha256(stem)[:8]` — e.g. `a3f8c21b` |
| `chunkId` | Dot-separated heading counters reflecting depth: `01`, `01-02`, `01-02-03` |

A chunk at `db/a3f8c21b/01-02.md` is the second H2-level section of the document whose filename hashes to `a3f8c21b`.

---

## Agent tools

The agent (defined in `src/agent/tools.ts`) has access to seven tools:

| Tool | Purpose |
|------|---------|
| `get_instructions` | Returns the agent's own guidance text from `src/agent/skill.ts` |
| `list_docs` | Lists all documents in the knowledge base via `_manifest.json` |
| `read_index` | Reads the full `_search_index.json` for structural overview |
| `search` | Full-text / regex search across chunks; supports doc scope and index-only mode; returns excerpts with context |
| `read_chunk` | Reads a single chunk file by `docId` + `chunkId` |
| `read_chunks` | Reads multiple chunks in one call |
| `parent` | Resolves the parent chunk of a given `chunkId` (walks up the heading hierarchy) |

---

## Development commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Run the Vitest suite (56 tests) |
| `npm run test:watch` | Watch mode |
| `npm run test:coverage` | Coverage report |
| `npm run ingest <path>` | Ingest a Markdown file or directory |

**Requirements:** Node.js 18+, npm

---

## Deployment

The build output in `dist/` is a fully static site. Copy it (along with the `db/` directory) to any static host.

For GitHub Pages, commit the `db/` directory and push `dist/` to your `gh-pages` branch. No server-side API key management is needed — users supply their own Anthropic API key in the UI, where it is stored only in `sessionStorage`.

---

---

# KnowDB（繁體中文）

KnowDB 是一個輕量級、純瀏覽器端的知識庫瀏覽器。將 Markdown 檔案攝入（ingest）為磁碟上的區塊（chunk）儲存，再透過雙面板網頁 UI 進行瀏覽與搜尋。右側面板執行一個以 Anthropic API（Claude Haiku）驅動的 AI 代理，能透過工具呼叫（tool use）查詢知識庫。

本應用不需要後端伺服器，為完全靜態網站。

---

## 快速開始

```bash
npm install

# 攝入單一檔案或整個目錄
npm run ingest raw/my-notes.md
npm run ingest raw/

# 啟動開發伺服器
npm run dev
```

在瀏覽器中開啟後，將您的 Anthropic API 金鑰貼入 UI 中的金鑰欄位，即可開始查詢。

---

## 攝入機制

`npm run ingest <path>`（`scripts/ingest.ts`）會解析每個 Markdown 檔案的標題層級，並將內容切割為區塊，輸出寫入 `db/` 目錄。

**目錄結構**

```
db/
  <docId>/
    _meta.json          # 標題、來源路徑、區塊數量
    <chunkId>.md        # 每個區塊一個檔案
  _manifest.json        # 所有 docId 與標題的清單
  _search_index.json    # 所有區塊的平坦索引，供搜尋使用
```

**ID 命名慣例**

| ID | 來源 |
|----|------|
| `docId` | `sha256(檔名不含副檔名)[:8]`，例如 `a3f8c21b` |
| `chunkId` | 以標題計數器反映深度的點線分隔格式：`01`、`01-02`、`01-02-03` |

`db/a3f8c21b/01-02.md` 代表雜湊為 `a3f8c21b` 之文件的第二個 H2 層級段落。

---

## 代理工具

代理（定義於 `src/agent/tools.ts`）可使用七種工具：

| 工具 | 用途 |
|------|------|
| `get_instructions` | 回傳代理自身的操作指引（來自 `src/agent/skill.ts`） |
| `list_docs` | 透過 `_manifest.json` 列出知識庫中的所有文件 |
| `read_index` | 讀取完整的 `_search_index.json`，用於結構性總覽 |
| `search` | 對區塊執行全文 / 正規表示式搜尋；支援文件範圍限定與純索引模式；回傳含上下文的摘錄 |
| `read_chunk` | 透過 `docId` + `chunkId` 讀取單一區塊檔案 |
| `read_chunks` | 單次呼叫讀取多個區塊 |
| `parent` | 解析指定 `chunkId` 的父區塊（沿標題層級向上遍歷） |

---

## 開發指令

| 指令 | 說明 |
|------|------|
| `npm run dev` | 啟動 Vite 開發伺服器（含 HMR） |
| `npm run build` | 產生正式版本至 `dist/` |
| `npm run preview` | 在本機預覽正式版本 |
| `npm test` | 執行 Vitest 測試套件（56 項測試） |
| `npm run test:watch` | 監看模式 |
| `npm run test:coverage` | 產生覆蓋率報告 |
| `npm run ingest <path>` | 攝入 Markdown 檔案或目錄 |

**環境需求：** Node.js 18+、npm

---

## 部署

`dist/` 中的建置產出為完全靜態網站。將其連同 `db/` 目錄複製到任何靜態主機即可。

若部署至 GitHub Pages，請提交 `db/` 目錄並將 `dist/` 推送至 `gh-pages` 分支。無需伺服器端的 API 金鑰管理——使用者在 UI 中自行提供 Anthropic API 金鑰，金鑰僅儲存於 `sessionStorage`，不會離開瀏覽器。
