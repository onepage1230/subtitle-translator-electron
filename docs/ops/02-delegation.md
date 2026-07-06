# 02 — Subagent 調度守則

寫給任何等級的模型照做，不需要自行判斷「值不值得派」——符合條件就派，照表選模型，照格式收貨。

## 1. 主對話不下場原則

主對話的職責是：拆任務、派工、收結論、做決策、對使用者回報。以下工作**必派 subagent**，主對話不自己動手：

| 任務類型 | 派給誰 | 例子 |
|---|---|---|
| 需要讀 3 個檔案以上、或任一檔超過 300 行的調查 | `Explore` agent | 「找出所有讀寫 `.series-glossary.json` 的地方」 |
| 掃整個 repo 的模式搜尋（命名慣例、用法統計、死碼） | `Explore` agent | 「哪些元件還在用舊的 `useLocalStorage` key」 |
| 查外部文件、網頁研究、比較方案 | `general-purpose` agent（或 `/ops-research` 模板） | 「Vercel AI SDK v5 的 tool-calling 改了什麼」 |
| 批次機械性修改（同一模式套用到多個檔案） | `general-purpose` agent | 「把 12 個測試檔的 import 路徑改成新格式」 |
| 產出物驗收（見 §6） | fresh-context `general-purpose` agent | read-back、跑測試、審查 |
| `translate.ts` 的修改審查 | 專案 agent `translation-pipeline-reviewer` | 任何動到翻譯核心的 diff |
| 產生 E2E 測試 | 專案 agent `e2e-writer`（frontmatter 未設 model＝inherit；派工時可用 `model: sonnet` 覆寫） | 新頁面加測試 |

**例外（主對話直接做，不派）**：
- 「某符號在哪、誰呼叫誰、改了會影響什麼」→ 直接用 codegraph MCP（`codegraph_context`，必要時補一個 `codegraph_explore`），2–3 次呼叫內能答完的不派工。
- 讀 1–2 個已知路徑的小檔案（< 300 行）。
- 已經拿到 檔案:行號 之後的單點修改。

判準一句話：**「找」的工作派出去，「查一個已知符號」用 codegraph，「改一個已知位置」自己動手。**

## 2. 派工三件套（每張派工單必含，缺一件就是不合格的派工）

1. **目標與動機**：要完成什麼＋為什麼要做（動機讓 subagent 在邊界情況能做對取捨）。
   - 壞例子：「看一下 glossary 相關的程式碼」
   - 好例子：「找出 `.series-glossary.json` 的所有讀寫點。動機：要加『手動鎖定詞條』功能，需要知道哪些路徑會覆寫這個檔。」
2. **驗收條件**：可客觀判定的完成標準（測試通過、檔案存在、列出 N 個以上結果、涵蓋哪些目錄）。
   - 例：「回報需涵蓋 electron/main/ 與 src/ 兩側；若某側完全沒有讀寫點，明確說『無』而不是省略。」
3. **回報格式**：明確指定回什麼、不回什麼（見 §4 回報合約）。

派工時一併給：相關檔案路徑起點、已知線索、絕對不要做的事（例如「只調查，不要改任何檔案」）。

## 3. model 欄位怎麼選

`.claude/agents/*.md` frontmatter 的 `model` 合法值：`haiku`、`sonnet`、`opus`、`fable`、完整 model ID（如 `claude-opus-4-8`）、`inherit`（預設）。Agent tool 呼叫時的 `model` 參數會覆寫 frontmatter（完整優先序見 `00-inventory.md` §7）。

| 值 | 什麼時候用 | 本環境的例子 |
|---|---|---|
| `haiku` | 機械性、格式明確、錯了容易發現的批次工作 | 批次改 import、跑指令收輸出、read-back 驗證 |
| `sonnet` | 預設值。搜尋、調查、實作、一般審查 | Explore 掃 repo、寫功能、`e2e-writer` |
| `opus` | Sonnet 連錯兩次的困難子任務；高風險判斷的第二意見 | 翻譯 pipeline 併發 bug 的根因分析 |
| `fable` / `claude-opus-4-8` 等完整 ID | 只在使用者明說要用時 | — |
| `inherit` | 跟主對話同級。只給「需要與主對話同等判斷力」的審查型 agent | `translation-pipeline-reviewer` |

現有兩個專案 agent 未設 `model` 欄位（＝inherit）。建議值：`e2e-writer` 設 `sonnet`；`translation-pipeline-reviewer` 維持 `inherit`。改 agent 定義檔前先讀 `04-maintenance.md` §1。

## 4. 回報合約（subagent 的回覆格式）

派工單裡照抄這段給 subagent：

> 回報只包含：(1) 結論（≤ 5 行）；(2) 證據清單，每條格式 `檔案路徑:行號 — 一句話說明`；(3) 沒找到／做不到的部分明說。**不要**貼程式碼全文、不要貼檔案全文、不要重述過程。長產物（報告、清單超過 30 行）寫到檔案，回報只給路徑。

主對話收貨時檢查：回報裡每個結論都有對應的 檔案:行號 嗎？沒有的結論視為未驗證，不能直接採用。

## 5. 升降級路徑

- **Haiku 錯一次 → 直接升 Sonnet。** 不要給 Haiku 第二次機會，除錯成本高於模型價差。
- **Sonnet 同一子任務連錯兩次 → 升 Opus**，且派工單必須附完整失敗軌跡：兩次分別怎麼做的、輸出什麼、錯在哪、已排除什麼。不附軌跡的升級會讓 Opus 重走一遍死路。
- **Opus 解出來之後 → 把解法寫成範例（模式 + 一個實際 diff），降回 Sonnet/Haiku 批次套用**到其餘同類位置。
- **嘗試次數上限：以 Sonnet 為起點共三次**（Sonnet 兩次 + Opus 一次）。Haiku 起手的任務，Haiku 那次失敗不計入這三次——升上 Sonnet 後重新照上述計算。三次用完還是不行就停下來，把失敗軌跡整理給使用者，附上你的判斷：是方向錯了、缺資訊、還是超出能力（判準見 `03-judgment.md` §4）。

「錯一次」的定義：驗收條件未達成（測試沒過、回報缺驗收要求的內容、read-back 不符），不是風格不合意。

## 6. 驗證不自驗

做的人不驗收自己的產出。驗收一律派 **fresh-context** subagent（新開的 Agent 呼叫，不帶做工過程的上下文），照產出類型選方法：

| 產出類型 | 驗收方法 | 派工單要求 |
|---|---|---|
| 文件／設定檔 | **read-back**：驗收者只拿「原始需求清單」，讀實際檔案，逐條回報有／無／矛盾 | 不要給它做工者的摘要，只給需求與檔案路徑 |
| 程式碼 | **測試或實跑**：跑 `npm test`；動到 UI 的跑 `npm run pree2e && npm run e2e`；貼回實際輸出，不接受「應該會過」 | 驗收條件寫成具體指令與預期輸出 |
| 高風險判斷（架構取捨、翻譯 pipeline 核心、資料遷移） | **第二意見**：升一級模型（或 `translation-pipeline-reviewer`）獨立審一次，兩份意見衝突時回報使用者裁決 | 給結論與依據，不給第一位審查者的推理過程 |

驗收者回報也走 §4 合約。驗收沒過 → 回到原做工者修（帶著驗收回報），計入 §5 的重試次數。
