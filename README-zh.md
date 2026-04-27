# KnowDB

*For English, see [README.md](README.md)*

> 給你地圖，不給你答案。

大多數知識庫把文件切成碎片，向量搜尋找出「最相近」的幾個，再由 LLM 整理後回傳一個答案。這個流程裡，Agent 是被動的——它接收系統認為相關的內容，沒有地圖，也看不見全局。

KnowDB 是一個探索不同前提的原型：如果知識層從一開始就設計成**知識資料庫**，讓 Agent 像讀者查閱文件一樣主動導航——沿著標題樹移動、按需展開脈絡、跨文件追蹤關鍵字——會是什麼樣子？

這個專案是這個想法的 **Tier 1**：能夠展示概念的最簡實作。知識庫是一個純 `.md` 檔案的資料夾，沒有後端，在瀏覽器中執行。

---

## 核心理念

KnowDB 的核心只有一件事：**給 Agent 一張地圖，讓它主動探索。**

不是給答案——是給線索讓 Agent 自己找到答案。其他一切設計都圍繞這件事展開：

**結構在 ingest 時保留，地圖才能存在。** 文件進入系統時，標題層級即成為 chunk 樹，每個 chunk 有穩定的位址（`db/<docId>/<chunkId>.md`）——`01` 是第一個頂層段落，`01-02` 是其第二個子段落。地圖不是查詢時臨時拼湊的，它在資料進來時就已建好。

**系統擁有索引，地圖才能可信。** Agent 的職責是查詢，不是維護地圖的完整性。Ingest pipeline 產生搜尋索引與標題樹，Agent 不寫入這些檔案——它信任地圖，不需要邊用邊猜邊修正。

**查詢 API 沿著文件樹設計，探索才能發生。** Agent 從最小的有用 context 開始，按需展開——沿著標題層級向下鑽取、向上回溯，或以關鍵字跨文件跳轉。何時需要更多資訊，由 Agent 決定，不是系統。

---

## 此原型

Tier 1 實作刻意不使用任何檔案系統以外的基礎設施：

- `npm run ingest <file.md>` 解析標題，將 chunk 檔案寫入 `db/`
- `_search_index.json` 由瀏覽器一次性載入，所有搜尋在用戶端執行
- UI 分為兩個面板：左側文件導覽，右側 Agent 問答
- Agent 有七個工具：`get_instructions`、`list_docs`、`read_index`、`search`、`read_chunk`、`read_chunks`、`parent`
- 無後端，可部署至任何靜態主機

### 查詢 API

七個工具依兩條導航軸分類：

| 工具 | 導航軸 | 用途 |
|------|--------|------|
| `get_instructions` | — | 會話開始時載入導航指引 |
| `list_docs` | — | 探索所有可用文件 |
| `read_index` | 垂直 | 取得文件的完整標題樹 |
| `read_chunk` | 垂直 | 透過穩定位址讀取單一 chunk 完整內容 |
| `read_chunks` | 垂直 | 一次呼叫取得多個 chunk 的 preview，供漸進探索後決定是否展開 |
| `parent` | 垂直 | 向上移動到父段落 |
| `search` | 水平 | 跨所有文件以關鍵字搜尋 chunk |

良好的 Agent 工作流模式：以 `list_docs` 和 `read_index` 定向，以 `search` 定位，以 `read_chunks` 預覽候選段落，以 `read_chunk` 展開完整內容，以 `parent` 縮放視角。

---

## 自行試用

先 clone ：

```bash
git clone https://github.com/kirisame-wang/knowdb.git
cd knowdb
npm install
```

將 `raw/` 中的檔案換成你自己的 Markdown 文件，再重建知識庫：

```bash
rm -rf db/
npm run ingest raw/
```

接著選擇查詢方式：

**方式 A — 瀏覽器 UI**（需要 Anthropic API 金鑰）

```bash
npm run dev   # 開啟 http://localhost:5173
```

在 UI 中貼上 API 金鑰即可提問。靜態部署請執行 `npm run build`。

**方式 B — 本地 Coding Agent**（不需要 API 金鑰，不需要瀏覽器）

在提示詞中引用 `SKILL.md`，agent 直接透過 `bash` 與 `grep` 導覽 `db/`。詳見[搭配本地 Coding Agent 使用](#搭配本地-coding-agent-使用)。

---

## 搭配本地 Coding Agent 使用

repo 根目錄的 `SKILL.md` 是一份供本地 coding agent（例如 Claude Code）使用的技能檔案。它說明如何透過 `bash` 與 `grep` 查詢知識庫——不需要瀏覽器，也不需要 API 金鑰。

**直接引用** — 在提示詞中提及檔案，agent 即時讀取：

```
@SKILL.md 2023 年的營業收入是多少？
```

**註冊為持久技能** — agent 每次執行時自動載入指引：

以下指令以 **Claude Code** 為目標。其他 agent 可能使用不同的技能目錄。

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

無論哪種方式，agent 都會遵循相同的四步驟工作流程——發現 → 定位 → 搜尋 → 讀取——回答關於 `db/` 中已攝入文件的問題。

---

## 為什麼結構很重要

大多數擷取系統把文件視為 chunk 的集合。作者花時間建立的標題層級——在 ingest 時被丟棄，查詢時再靠 LLM 猜回來。

KnowDB 保留了這個結構。位於 `db/doc/01-02-03.md` 的 chunk 不只記錄了內容，也編碼了位置：它是某文件第二段落的第三個子段落。Agent 讀到這個 chunk 時，確切知道自己身在何處、前面是什麼、下一步去哪裡。它不需要從零散段落中推斷文件的整體形狀。

這對技術文件、設計規格、研究論文尤其重要——這類文件的標題結構反映了刻意的組織邏輯，而非隨機分頁。

KnowDB 從一開始就做了不同的假設。向量資料庫預設正確的文件存在，且可以一次搜尋命中——它傳回語義最近的 top-k chunk，並預期答案就在其中。KnowDB 不做這種假設。它提供索引作為一組線索，讓 Agent 自行決定去哪裡。索引不是篩選正確答案的過濾器，而是記錄現有知識的地圖。

這改變了失敗的形態。向量搜尋失誤時，它靜默失敗——Agent 收到看起來合理的 chunk，卻毫無線索正確內容從未被取出。KnowDB 導航結果為空時，Agent 知道：缺口是明確的，不是隱藏的。

KnowDB 同時反轉了傳統 RAG 的責任分配：

|  | 傳統 RAG | KnowDB |
|--|----------|--------|
| **語義層** | 嵌入模型 | Agent 本身 |
| **結構層** | LLM 在查詢時推斷 | 系統在 ingest 時維護 |
| **雜訊來源** | 向量密度分布不均 | 關鍵字 + 摘要；Agent 過濾 |

傳統 RAG 要求嵌入模型處理語義、LLM 重建結構——兩者都不是它們最擅長的事。KnowDB 把每項工作分配給合適的一方：系統負責結構，Agent 負責意義。Agent 本身已經是語義匹配層，能將自然語言問題轉化為關鍵字。Agent 無法可靠做到的，是從零散 chunk 推斷文件形狀。KnowDB 在 ingest 時就解決了這個問題，讓 Agent 從不需要面對它。

---

## 兩條導航軸

KnowDB 的查詢 API 提供兩種互補的導航方式：

**垂直導航**沿文件本身的結構移動。Agent 從 `read_index` 取得完整標題樹，以 `read_chunk` 深入特定段落，再以 `parent` 向上回溯。文件的層級結構——作者賦予它的組織方式——就是地圖。

**水平導航**透過關鍵字搜尋跨越文件邊界。`search` 會從知識庫中所有文件傳回符合的 chunk。這些跨文件連結是**隱性的**：它們不是事先定義的圖譜邊，而是查詢時從共同概念中自然湧現的關係。Agent 在每個步驟自行決定：要繼續深入目前文件，還是跳到相關的其他文件？

垂直與水平導航共同構成 KnowDB 的核心能力：利用文件的自然層級結構與關鍵字跳轉，讓 Agent 有效找到所需知識。

---

## 擴展藍圖

三層設計共享相同的工作流程——按需對文件層級結構進行搜尋——差別只在底層的儲存層。

Tier 1 驗證工作流程：Agent 能否在不需要後端、不需要向量嵌入、不需要圖資料庫的情況下，利用文件的自然標題層級和關鍵字搜尋來找到所需知識？如果答案是肯定的，這個工作流程就是可行的。

Tier 2 和 Tier 3 將這個已驗證的工作流程延伸至新的約束條件：多使用者並發、大規模語料庫、企業級擷取。資料庫設計跟隨工作流程——而非反過來。進入下一層之前，始終先問：現有基礎設施是否已能滿足這一層的需求？

| 層級 | 儲存技術 | 規模 | 狀態 |
|------|---------|------|------|
| **1 — 檔案系統** | 純 `.md` 檔案 + JSON 索引 | 數十至數百份文件 | 此原型 |
| **2 — 嵌入式 DB** | SQLite FTS5（sqlite-wasm） | 數千份文件 | 規劃中 |
| **3 — 企業級** | 待定 | 數十萬份文件以上 | 未來規劃 |

Tier 2 與 Tier 3 的詳細設計與規格文件將另行公開。

---

## 貢獻指南

歡迎提交 Issue 與 Pull Request。

以下幾個方向特別有幫助：

- **錯誤回報** — 若 ingest 產生非預期的 chunk 切割，或 Agent 行為異常，附上最小重現案例會很有幫助
- **Ingest 邊緣案例** — 導致標題解析器出錯的 Markdown 結構
- **Agent 工具回饋** — Agent 導覽過程中的觀察，包括卡住的情況，或有助於改善檢索的工具設計建議
- **Tier 2 方向討論** — 關於 SQLite FTS5 路徑或嵌入式 DB 查詢 API 的想法

較大幅度的修改，建議先開 Issue 討論方向，再著手撰寫程式碼。
