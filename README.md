# KnowDB

A concept prototype exploring one question: can a knowledge base be just a folder of plain text files — no database, no server, no infrastructure — yet still support structured retrieval and AI-assisted Q&A?

---

## Design ideas

**1. Filesystem as database.** Ingestion parses a Markdown file's heading hierarchy and writes one `.md` file per chunk under `db/<docId>/<chunkId>.md`. The chunk ID encodes position in the heading tree: `01` is the first top-level section, `01-02` is its second subsection, `01-02-03` goes one level deeper. The structure is navigable by any tool that can list files.

**2. Static deployment.** The entire app — UI and knowledge base — is a folder of static files. No backend process, no build step at runtime. Drop it on GitHub Pages or any file server and it works.

**3. Browser-side search.** The ingest step produces `_search_index.json`, a flat listing of every chunk. The browser loads it once and handles regex search, excerpt extraction, and structural navigation entirely client-side.

**4. Tool-use agent.** The AI assistant navigates the knowledge base through tools: `get_instructions`, `list_docs`, `read_index`, `search`, `read_chunk`, `read_chunks`, `parent`. Notably, the agent fetches its own usage guide on demand via `get_instructions` rather than having it baked into the system prompt — the instructions are themselves just another document in the knowledge base.

---

## Try it yourself

```bash
git clone https://github.com/yourname/knowdb.git
cd knowdb
npm install
npm run ingest raw/        # ingest the sample documents
npm run dev                # open http://localhost:5173
```

Paste your Anthropic API key into the key field in the UI and start asking questions.

---

## Deployment

Build with `npm run build`, then copy `dist/` and `db/` to any static host. The API key never leaves the browser — it is stored only in `sessionStorage`.

---

# KnowDB

一個概念原型，探索一個問題：知識庫能否只是一個純文字檔案的資料夾——沒有資料庫、沒有伺服器、沒有任何基礎設施——卻仍能支援結構化檢索與 AI 輔助問答？

---

## 設計理念

**1. 檔案系統即資料庫。** 攝入（ingest）步驟會解析 Markdown 檔案的標題層級，並將每個區塊寫成一個獨立的 `.md` 檔案，存放於 `db/<docId>/<chunkId>.md`。區塊 ID 編碼了該區塊在標題樹中的位置：`01` 為第一個頂層段落，`01-02` 為其第二個子段落，`01-02-03` 再深一層。整個結構可被任何能列出檔案的工具所遍歷。

**2. 靜態部署。** 整個應用程式——UI 與知識庫——都只是一個靜態檔案資料夾。不需要後端程序，執行期間也不需要任何建置步驟。丟到 GitHub Pages 或任何靜態伺服器即可運作。

**3. 瀏覽器端搜尋。** 攝入步驟會產生 `_search_index.json`，這是所有區塊的平坦清單。瀏覽器載入一次後，即可在用戶端完成正規表示式搜尋、摘錄擷取與結構性導覽，完全不需要伺服器。

**4. 工具呼叫代理。** AI 助理透過工具導覽知識庫：`get_instructions`、`list_docs`、`read_index`、`search`、`read_chunk`、`read_chunks`、`parent`。值得一提的是，代理透過 `get_instructions` 按需取得自身的使用說明，而非將其硬編碼於系統提示中——這份說明本身就是知識庫中的另一份文件。

---

## 自行試用

```bash
git clone https://github.com/yourname/knowdb.git
cd knowdb
npm install
npm run ingest raw/        # 攝入範例文件
npm run dev                # 開啟 http://localhost:5173
```

在 UI 的金鑰欄位貼上您的 Anthropic API 金鑰，即可開始提問。

---

## 部署

執行 `npm run build`，再將 `dist/` 與 `db/` 複製到任何靜態主機。API 金鑰永遠不會離開瀏覽器——它僅儲存於 `sessionStorage`。
