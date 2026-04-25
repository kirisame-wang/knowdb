# KnowDB

> For English, see [README.md](README.md)

大多數知識庫圍繞著檢索 pipeline 構建——文件輸入、向量輸出，再把幾個 chunk 交給 LLM 整理。KnowDB 是一個探索不同前提的原型：如果知識層從一開始就以 **知識資料庫** 的形態設計，專為 Agent 的存取模式而生，會是什麼樣子？

目標不是 RAG pipeline，也不是 LLM wiki。而是一個資料庫：文件以強制的結構進入系統，索引由系統維護（而非 LLM），查詢 API 則設計來對應 Agent 實際導覽知識的方式——沿著文件樹移動、按需擴展脈絡、跨段落跳轉。

這個 repository 是這個想法的 **Tier 1**：能夠展示概念的最簡實作。知識庫是一個純 `.md` 檔案的資料夾，沒有後端，在瀏覽器中執行。

---

## 核心理念

為 Agent 設計的知識資料庫，有三個特性使其有別於一般知識庫：

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
| **3 — 企業級** | 待定 | 數十萬份文件以上 | 未來規劃 |

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

---

## 搭配本地 Coding Agent 使用

repo 根目錄的 `SKILL.md` 是一份供本地 coding agent（例如 Claude Code）使用的技能檔案。它說明如何透過 `bash` 與 `grep` 查詢知識庫——不需要瀏覽器，也不需要 API 金鑰。

有兩種使用方式：

**方式 A — 直接引用。** 在提示詞中提及檔案，agent 即時讀取：

```
@SKILL.md 請問 2023 年的營業收入是多少？
```

**方式 B — 註冊為持久技能。** agent 每次執行時自動載入指引：

以下指令以 **Claude Code** 為目標。其他 agent 可能使用不同的技能目錄。

```bash
# macOS / Linux
mkdir -p .claude/skills/knowdb-local-search
cp SKILL.md .claude/skills/knowdb-local-search/Skill.md
```

```powershell
# Windows (PowerShell)
New-Item -ItemType Directory -Force .claude\skills\knowdb-local-search
Copy-Item SKILL.md .claude\skills\knowdb-local-search\Skill.md
```

```cmd
:: Windows (CMD)
mkdir .claude\skills\knowdb-local-search
copy SKILL.md .claude\skills\knowdb-local-search\Skill.md
```

無論哪種方式，agent 都會遵循相同的四步驟工作流程——發現 → 定位 → 搜尋 → 讀取——回答關於 `db/` 中已攝入文件的問題。

---

## 貢獻指南

歡迎提交 Issue 與 Pull Request。

以下幾個方向特別有幫助：

- **錯誤回報** — 若 ingest 產生非預期的 chunk 切割，或 Agent 行為異常，附上最小重現案例會很有幫助
- **Ingest 邊緣案例** — 導致標題解析器出錯的 Markdown 結構
- **Agent 工具回饋** — Agent 導覽過程中的觀察，包括卡住的情況，或有助於改善檢索的工具設計建議
- **Tier 2 方向討論** — 關於 SQLite FTS5 路徑或嵌入式 DB 查詢 API 的想法

較大幅度的修改，建議先開 Issue 討論方向，再著手撰寫程式碼。
