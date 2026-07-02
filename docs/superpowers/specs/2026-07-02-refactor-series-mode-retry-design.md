# 設計文件：Main Process 重構、劇集模式、失敗行重試

日期：2026-07-02
狀態：已與使用者確認設計，待撰寫實作計畫

## 背景

專案盤點（v1.9.1）發現的主要問題：

- `electron/main/index.ts` 782 行，其中 `batch-translate` handler 約 450 行單體，
  混合了分析協調、resume、chunk 處理、逐行 fallback、進度回報，且與 IPC 綁死，無法單元測試。
- 純函式（`retryTranslate`、`mergeGlossaries`、`formatAnalysisContext`、`hashContent`、
  `makeKey` 等）散落在 `index.ts`。
- `makeKey` 在 `electron/main/index.ts` 與 `src/components/TranslatorPanel.tsx` 重複定義。
- 「parsed subtitle 三種形狀」（array / `{full, events}`）的判斷邏輯在三處重複。
- 副檔名 filter 誤寫為 `.saa`（應為 `.ssa`），SSA 檔案無法選入。
- 最終逐行 fallback 迴圈缺乏錯誤隔離：單行重試耗盡即拋錯，整檔標為 error。
- 使用者需求：跨集翻譯名詞不同步（同一劇集各集譯名不一致）；失敗行只能整檔重跑。

使用者選定的三個工作項，依序實作，各自獨立可交付：

1. Phase 1 — 重構 main process（管線抽離，做法 A：不動 Electron 安全設定）
2. Phase 2 — 劇集模式（同資料夾自動分組 + 累積式共用詞彙表）
3. Phase 3 — 失敗行重試（重用 resume 機制）

---

## Phase 1：重構 main process

### 目標結構

```
electron/main/
  index.ts            — 只剩視窗管理 + IPC 接線（薄層）
  utils/
    translate.ts      — 維持現狀：AI 呼叫層（chunk / single / analyze / synthesize）
    subtitle.ts       — parseSubtitle、saveTranslated、splitIntoChunk、normalizeCues
    analysis.ts       — 分析協調：分段平行分析、mergeGlossaries、formatAnalysisContext、
                        hashContent、.analysis.json 快取讀寫
    pipeline.ts       — translateFile(file, params, onProgress)：resume 預填、
                        上下文視窗 chunk 翻譯、逐行 fallback、失敗標記、部分寫檔、
                        retryTranslate（含可重試錯誤判斷；只被 pipeline 使用，不另開模組）
shared/
  subtitleKey.ts      — makeKey 單一來源，main 與 renderer 共用
```

### 模組邊界

- **`pipeline.ts`**：輸入為檔案資訊 + 翻譯參數 + `onProgress` callback，
  輸出為翻譯結果與失敗清單。完全不 import `electron`，可用 mock 的 AI 層做單元測試。
  `index.ts` 的 `batch-translate` handler 縮減為：檔案層並行控制 +
  將 `onProgress` 轉發為 `event.sender.send("batch-progress", ...)`。
- **`analysis.ts`**：封裝「讀快取 → 分段平行分析 → 合併 glossary → 綜合 plot summary →
  寫快取」的完整流程，對外提供單一入口（如 `getOrCreateAnalysis`）。
  `check-analysis-cache` IPC 也改用此模組。
- **`subtitle.ts`**：`normalizeCues(parsed)` 統一處理三種 parsed 形狀，
  取代目前三處重複的 if/else 判斷。
- **`shared/subtitleKey.ts`**：`makeKey(start, end)` 唯一定義，
  main（resume、失敗追蹤）與 renderer（失敗行標示）共用。

### 順手修正（包含在 Phase 1）

- `.saa` → `.ssa` 副檔名 typo（`TranslatorPanel.tsx` 的 drop filter 與 `<input accept>`）。
- 最終逐行 fallback 迴圈加入逐行 try/catch：單行重試耗盡改標 `__FAILED__` 並記入
  failedKeys，不再讓整檔變 error。
- 更新 `CLAUDE.md`：`useOpenAI.ts` 現在只是 localStorage hooks，
  移除「鏡像主程序翻譯邏輯」的過時描述。

### 測試（引入 vitest）

- **特徵測試先行**：重構前先對現有 `batch-translate` handler 的 `batch-progress`
  事件序列（status 轉換、progress 區間、payload 欄位）建立特徵測試
  （characterization test），重構後必須通過同一組測試——
  「payload 維持相容」以此驗證，不靠宣告。
- 純函式單元測試：`splitIntoChunk`（含跳過已翻譯行）、`parseNumberedList`、
  `mergeGlossaries`（大小寫去重、先到者勝）、`formatAnalysisContext`（空 glossary 省略）、
  `makeKey`（數字四捨五入、字串 trim）、`retryTranslate`（fake timers 驗證
  指數退避與可重試判斷）、`normalizeCues`（三種形狀）。
- `pipeline.ts` 流程測試（mock AI 層）：resume 預填與跳過、chunk 視窗計算、
  三層 fallback 觸發順序、失敗標記與錯誤隔離、進度 callback 序列。
- `subtitle.ts` 解析/序列化 round-trip 測試（SRT/VTT/ASS 各一個 fixture）。
- 不新增 e2e；既有 Playwright 設定不動。

### 不做的事

- 不動 `nodeIntegration: true` / `contextIsolation: false`（使用者已明確排除安全性重構）。
- 不改 renderer 的 IPC 呼叫方式與事件格式（`batch-progress` payload 維持相容）。
- 不重構 `TranslatorPanel.tsx`（Phase 3 只做最小 UI 增量）。

---

## Phase 2：劇集模式（累積式共用詞彙表）

### 行為

- **分組**：位於同一資料夾的字幕檔自動視為同一劇集。零設定、無新 UI、無開關。
- **儲存**：`<資料夾>/.series-glossary.json`，格式：

  ```json
  {
    "terms": [{ "term": "...", "translation": "...", "category": "person" }]
  }
  ```

- **注入**：翻譯某集前讀取該資料夾的 series glossary：
  1. 注入分析 prompt，引導模型沿用既有譯名（分析 system prompt 附上既有詞彙表，
     指示「這些既有譯名必須沿用」）。
  2. 與該集分析結果的 glossary 合併後進入 `[Context]`，隨每個翻譯請求送出。
- **回寫**：該集分析完成後，`mergeGlossaries(series 既有, 本集新增)`——
  同 term（不分大小寫）以先到者勝——寫回 `.series-glossary.json`。
- **plot summary 維持單集**，不跨集共用。
- **`forceReanalyze`** 只重建該集的 `.analysis.json` 快取；series glossary 照常累積，
  既有 term 不被覆蓋。若累積的譯名有誤，重置方式為**刪除
  `.series-glossary.json`**——這是明文支援的操作，下次翻譯會重建。

### 詞彙表准入條件與上限

- **准入條件（結構化強制）**：`analysisSchema` 的 glossary entry 增加
  `category` 欄位，enum：`person`（人名）、`place`（地名）、
  `organization`（組織／團體）、`term`（稱號、虛構名詞、專業術語）。
  分析 prompt 明確指示：只收專有名詞——人名、地名、組織名、稱號、
  作品內虛構或專業術語；**排除一般名詞、常用詞、日常短語與完整句子**。
  模型必須為每條詞彙分類，schema 驗證失敗或無法歸入四類者不得進入詞彙表。
- **上限 100 條**：series glossary 儲存與注入均以 100 條為上限，
  超過時依 category 優先序 `person > organization > place > term` 裁剪，
  同序內先到者勝。此上限同時防止長劇追番情境下 prompt 無限膨脹。
- **舊快取相容**：既有 `.analysis.json` 快取的 glossary entry 缺 `category`
  欄位者一律視為 `term`，快取不作廢。

### 處理順序調整

- 同資料夾的檔案改為**循序**處理，依檔名自然排序（natural sort，
  使 `EP2` 排在 `EP10` 前），確保後集吃到前集詞彙。
- 不同資料夾之間維持並行（檔案層 pool 以「資料夾」為單位分組）。
- 單檔內部 chunk 並行（預設 10 / local 3）不變，吞吐損失有限。

### 邊界情況

- 資料夾內只有一個檔案：行為與現況相同（glossary 仍會寫出，供之後新集數使用）。
- `.series-glossary.json` 損毀或格式不符：忽略並以本次分析結果重建，不中斷翻譯。
- 分析整體失敗（現有 catch 路徑）：不寫 series glossary，翻譯照常進行。

### 測試

- glossary 合併與回寫的單元測試（先到者勝、大小寫、損毀檔案容錯）。
- 准入與上限測試：無效 category 被拒收；超過 100 條時依優先序裁剪；
  缺 category 的舊快取 entry 視為 `term`。
- 檔名自然排序測試。
- pipeline 層測試：第二個檔案的分析 prompt 包含第一個檔案產出的詞彙。

---

## Phase 3：失敗行重試

### 機制

利用既有行為的組合：失敗行（`__FAILED__`）存檔時寫出的是**原文**，
而 resume 邏輯本來就只預填「譯文 ≠ 原文」的行。因此：

> 「重譯失敗行」＝ 對該檔案重跑一次翻譯管線。
> resume 自動跳過已完成的行，只有失敗行（與極少數譯文恰等於原文的行）會被重譯；
> 分析走 `.analysis.json` 快取，不重跑。

### 實作

- **IPC**：新增 `retry-file`（payload：單一檔案 + params），
  內部呼叫 Phase 1 的 `translateFile`，進度同樣走 `batch-progress` 事件，
  renderer 無需新的事件處理邏輯。
- **UI**（`TranslatorPanel.tsx` 最小增量）：
  - 檔案狀態為 `done` 且 `failedCues > 0` 時，modal 頂部顯示
    「N 行失敗」提示與「重譯失敗行」按鈕。
  - 點擊後呼叫 `retry-file`，按鈕進入 disabled 狀態，完成後以新的
    `batch-progress` 資料更新 failedKeys 與預覽。
- **多語存檔限制**：`multiLangSave ≠ none` 時 resume 本來就停用，
  重試按鈕在此情況下不顯示（與現有 resume 行為一致）。

### 測試

本 Phase 依賴「失敗行存檔為原文 + resume 跳過相同文字」這組既有行為的組合，
必須用測試釘死，防止未來改動默默破壞：

- pipeline 測試：翻譯結果含 `__FAILED__` 行的檔案存檔後，重跑 `translateFile`
  → 只有失敗行被送去翻譯，已完成行不重譯、內容不變。
- `saveTranslated` 單元測試：`__FAILED__` 行寫出原文（SRT/VTT 與 ASS 兩條路徑）。
- resume 單元測試：譯文等於原文的行不被預填為已完成。

### 已知取捨

- 譯文恰好等於原文的行（數字、專有名詞、「OK」等）會被順便重譯一次，無害。
- 應用程式重啟後 failedKeys（記憶體內）遺失，重試按鈕不再顯示；
  使用者仍可整檔重跑（resume 會跳過已完成行），行為等價。

---

## 實作順序與交付

1. **Phase 1** 先行：Phase 2 依賴 `analysis.ts` 模組邊界，Phase 3 依賴
   `pipeline.ts` 的 `translateFile` 入口。
2. 每個 Phase 獨立 commit / 可交付，`batch-progress` 事件格式全程維持相容。
3. **commit 切分原則**：Phase 1 內的行為變更（`.saa` 修正、fallback 錯誤隔離）
   與純搬移重構各自獨立 commit，review 時可明確區分「行為改了」與「程式碼搬了」。
4. 版本規劃：Phase 1 為內部重構（patch），Phase 2、3 為新功能（minor）。
