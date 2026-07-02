# 詞彙表 UI 編輯 — 設計文件

日期:2026-07-03
狀態:已與使用者逐段確認通過

## 背景與目的

韓日劇字幕的官方譯名修正是常態操作(例如 白賢宇 → 白賢祐)。目前使用者必須手動編輯
`.series-glossary.json`,不友善。本功能讓使用者在 TranslatorPanel 的檔案 modal 內
直接編輯譯名與刪除條目,寫回資料夾層級的 series glossary;既有的 LOCKED 機制
(`enforceReconciliation` 以 series glossary 為 locked 來源)保證編輯後所有集數與
人名變體自動沿用新譯名。

**能力範圍**:編輯譯名 + 刪除條目。不做新增條目、不做類別編輯、不做刪除復原
(復原需手動編輯 JSON 將 term 從 `excluded` 移除——已知限制)。

## 架構總覽

採「細粒度操作型 IPC」:renderer 每次操作發一個 op 給 main process,
main 集中處理 load → 修改 → save,回傳更新後的完整詞彙表,renderer 以回傳值重繪。
renderer 不持有待儲存狀態、不做樂觀更新;所有業務規則(排除清單、userEdited 標記、
驗證)集中在 main process 的 `seriesGlossary.ts`。

## 1. 資料格式與 seriesGlossary.ts

### 檔案格式

`.series-glossary.json` 從 `{ terms: [...] }` 擴充為:

```json
{
  "terms": [
    { "term": "백현우", "translation": "白賢祐", "category": "person", "userEdited": true }
  ],
  "excluded": ["some term"]
}
```

- `excluded`:被刪除條目的 term,統一小寫(與現有 `toLowerCase()` 去重鍵一致)。
  缺省視為 `[]`,舊檔案向後相容。
- `GlossaryEntry` 新增可選欄位 `userEdited?: boolean`,使用者編輯過的條目為 `true`。
  此欄位純屬 UI 顯示標記,不影響合併或調和邏輯。

### 函式變更

- `loadSeriesGlossary(folder)` 改回傳 `{ terms, excluded }`(更新 `pipeline.ts`
  唯一呼叫點)。損壞 JSON 維持現行為:回空。
- `mergeIntoSeriesGlossary(existing, incoming, excluded)` 新增第三參數:
  合併時跳過 excluded 中的 term(lowercase 比對)。這是「刪除持久生效」的實作點——
  任何一集的 `.analysis.json` 快取詞彙表想把被刪條目合併回來,都在此被擋下。
- `saveSeriesGlossary(folder, terms, excluded)` 寫回完整結構;改為回傳成功與否
  (boolean)。pipeline 呼叫點忽略回傳值(唯讀資料夾不擋翻譯,行為不變)。
- 新增純函式(供 IPC handler 使用、可單元測試):
  - `editGlossaryTranslation(data, term, translation)`:更新譯名並設
    `userEdited: true`。translation trim 後為空、或 term 找不到(lowercase 比對)
    時不套用,回傳原資料。
  - `deleteGlossaryTerm(data, term)`:從 `terms` 移除該條目,term(lowercase)
    加入 `excluded`。重複刪除為 no-op。

### 與既有機制的互動

LOCKED 機制不需修改:series glossary 內的條目本來就是 reconciliation 的 locked
來源,編輯寫回即自動鎖定。excluded 條目因不在 `terms` 中,自然不會進入
`[Context]`、分析的 `existingGlossary`、或調和流程。

## 2. IPC 介面

新增兩個 handler(`electron/main/index.ts`,邏輯放 `seriesGlossary.ts`):

### `get-series-glossary`

- 參數:`filePath`(main 以 `path.dirname` 取資料夾,路徑邏輯不外洩到 renderer)。
- 回傳:`{ terms: GlossaryEntry[] }`。檔案不存在回 `{ terms: [] }`。

### `update-series-glossary`

- 參數:`{ filePath, op }`,其中:

```ts
type GlossaryOp =
  | { type: "edit"; term: string; translation: string }
  | { type: "delete"; term: string };
```

- 流程:load → 套用操作(上述純函式)→ save → 回傳更新後的 `{ terms }`。
- 驗證失敗(空譯名、term 不存在)不套用、回傳現況;UI 重繪後自然回到正確狀態,
  不需錯誤彈窗。
- 寫入失敗(如唯讀資料夾)→ handler throw,由 renderer 顯示錯誤。

### 併發防護

翻譯進行中(`isTranslating`)UI 停用編輯與刪除,main 的 read-modify-write
不會與 pipeline 的 `saveSeriesGlossary` 交錯。

## 3. UI 設計(TranslatorPanel modal 詞彙表區)

### 資料載入與顯示

- modal 開啟時呼叫 `get-series-glossary`,結果存 `seriesGlossary` state;
  plot summary 維持現狀來自 `selectedAnalysis`。
- `seriesGlossary.terms` 非空 → 顯示可編輯的系列詞彙表,區塊標題改為「系列詞彙表」。
- 為空(只分析過、未翻譯過的舊資料)→ 退回現行唯讀顯示 `selectedAnalysis.glossary`,
  行為與現在相同。

### 每列互動

- 版面沿用現有 `term: translation` 列表。點擊譯名 → inline `<input>`,
  Enter/blur 儲存、Esc 取消;儲存發 edit op,以回傳值更新清單。
- 列尾刪除 icon(`bx-trash`),兩段式確認:第一下變紅「確認刪除?」,再按才刪,
  點其他地方復原。
- `userEdited` 條目在 term 旁顯示鎖頭 icon(`bx-lock-alt`),tooltip:
  「使用者修改過,譯名已鎖定」。

### 狀態控制

- `isTranslating` 時編輯與刪除 disabled。
- 本次 modal 開啟期間有過成功修改,詞彙表區底部顯示提示:
  「已更新系列詞彙表;已翻譯的檔案需重新翻譯才會套用新譯名」。

### i18n

新增字串(標題、提示、tooltip、確認刪除、錯誤訊息)同步加入 `en-US`、`zh-TW`、
`zh-CN` 三個語言檔;完成後以 `/i18n-sync` 驗證。

## 4. 錯誤處理

- 寫入失敗:`update-series-glossary` throw → renderer catch → 詞彙表區顯示一行
  紅色錯誤(「寫入詞彙表失敗,請檢查資料夾權限」),清單維持原狀。
- 損壞 JSON:`loadSeriesGlossary` 回空(既有行為),UI 呈現為空、退回唯讀顯示。
- IPC 呼叫失敗:同寫入失敗處理。

## 5. 測試(Vitest,tests/unit/)

- `editGlossaryTranslation`:正常編輯設 `userEdited`;空白譯名不套用;
  term 不存在不套用;lowercase 比對。
- `deleteGlossaryTerm`:移除 + 進 excluded;重複刪除 no-op。
- `mergeIntoSeriesGlossary`:excluded 條目被跳過(刪除持久性核心);
  無 excluded 時行為與現行完全相同。
- `loadSeriesGlossary` / `saveSeriesGlossary`:新格式往返;舊格式(無 `excluded`)
  向後相容。
- 不新增 E2E:modal inline 編輯的 Playwright 成本高,核心邏輯皆在純函式層。

## 已知限制

- 刪除條目的復原需手動編輯 `.series-glossary.json`(從 `excluded` 移除)。
- 編輯譯名不會回寫已翻譯完成的 `.translated` 檔,需使用者重新翻譯(UI 有提示)。
- 不支援新增條目與類別編輯。
