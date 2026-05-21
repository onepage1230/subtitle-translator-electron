# Translation Robustness Design

**Date:** 2026-05-21  
**Status:** Approved

## Background

四個問題需要解決：

1. 本地 LLM（oMLX）翻譯到一半出現 schema 驗證失敗，導致整個檔案中止
2. 翻譯中斷後無法接續，必須從頭來過
3. `delay` 設定在 UI 可調整，但 main process 完全未使用
4. 死碼：`step` Redux slice、renderer-side `useTranslate`

---

## 功能一：接續翻譯（Resume）

### 目標
重新對同一個字幕檔開始翻譯時，自動跳過已翻譯的行，從斷點繼續。

### 實作位置
`electron/main/index.ts` — `processFile` 函式開頭

### 流程

```
processFile 開始
  ↓
計算 outputPath（<name>.translated.<ext>）
  ↓
outputPath 存在？
  ├─ 是 → parseSubtitle 讀取已翻譯檔案
  │        以 start|end 時間戳建立 Map<"start|end", translatedText>
  │        遍歷原始字幕，對照 Map 預填 cue.data.translatedText
  │        （索引 fallback：時間戳找不到時用索引對照）
  └─ 否 → 略過
  ↓
splitIntoChunk（已有 translatedText 的行自動跳過）
  ↓
僅翻譯剩餘行
```

### 關鍵設計決策

- **時間戳 Key 匹配**：用 `Math.round(start) + "|" + Math.round(end)` 作為 Key，與 `get-subtitle-preview` 現有邏輯一致，不依賴索引順序，正確處理並行翻譯的非連續完成順序。
- **`__FAILED__` 視為未翻譯**：Resume 邏輯只預填真正有翻譯內容的行（非空、非 `__FAILED__`），讓失敗行在下次執行時自動重試。
- **原子寫入保護**：現有的 `.tmp` rename 機制已防止讀取到寫一半的檔案。

---

## 功能二：Chunk 錯誤處理 + 第三層 Fallback

### 目標

- 本地 LLM 無法產生合法 JSON 時，改用更寬鬆的純文字解析
- 任何 chunk 失敗不中止整個檔案，改為標記失敗行並繼續
- 使用者可以透過「再次開始翻譯」自動重試失敗行（Resume 機制處理）

### 三層 Fallback 策略

在 `electron/main/utils/translate.ts` 的 `translateSubtitleChunk`：

```
第一層：Tool calling（generateText + toolChoice: "required"）
  ↓ 失敗或行數不符
第二層：generateObject（Zod array schema）
  ↓ 失敗或行數不符
第三層：純文字編號列表（新增）
  System prompt 說明格式要求
  User prompt：
    "Translate each line and reply ONLY in this format:
     1. [translation]
     2. [translation]
     ..."
  解析：regex /^\d+\.\s*(.+)$/gm 提取每行
  驗證：行數必須與輸入相同，否則視為失敗
```

所有三層都包在現有的 `retryTranslate`（最多 5 次、指數退避）內。

### Chunk 層級錯誤隔離

在 `electron/main/index.ts` 的 `chunkProcessor`，將拋出的例外改為捕捉：

```
chunkProcessor
  ↓
translateSubtitleChunk（含三層 fallback）
  ├─ 成功（且行數吻合）→ 正常寫入 translatedText
  └─ 三層全部失敗 → 不拋出
       將該 chunk 每一行標記 cue.data.translatedText = "__FAILED__"
       繼續處理下一個 chunk
```

### 失敗行的處理

- **儲存時**：`saveTranslated` 需明確處理 `__FAILED__`——因為它是 truthy 字串，現有的 `translatedText || text` 邏輯會錯誤地寫入 `"__FAILED__"` 字面值。需改為 `(translatedText === "__FAILED__" || !translatedText) ? text : translatedText`。
- **UI 顯示**：翻譯完成的 `batch-progress` done 事件加入 `failedCues: number`。`TranslatorPanel` 在檔案列表顯示「完成（N 行翻譯失敗）」。Modal 內，`translatedText === "__FAILED__"` 的行以橙色標示。
- **重試**：使用者直接再按「開始翻譯」，Resume 機制自動跳過成功行、重試 `__FAILED__` 行，無需額外 UI。

---

## 功能三：修復 Delay 設定

### 現有問題

`useDelay` → `delay * 1000` 作為 `params.delay` 傳入 main process，但 `chunkProcessor` 完全未使用 `params.delay`。

### 修復位置

`electron/main/index.ts` — `chunkProcessor` 函式尾端，`saveTranslated` 之後：

```typescript
if (params.delay && params.delay > 0) {
  await new Promise(resolve => setTimeout(resolve, params.delay));
}
```

### 效果

Delay 在每個 chunk 完成後暫停，推遲釋放 pool slot，有效控制對本地 LLM 的請求間隔。

---

## 功能四：死碼清理

### 移除項目

| 位置 | 內容 | 原因 |
|------|------|------|
| `src/store/step.ts` | `stepSlice`（`nextStep`、`previousStep`） | 從未被 dispatch，無用途 |
| `src/store.ts` | `stepReducer` import 及 `step:` 設定 | 隨 step slice 一併移除 |
| `src/hooks/useOpenAI.ts` | `useTranslate` 函式 | 翻譯全走 IPC，renderer-side 版本未被使用 |

### 保留項目

`useOpenAI.ts` 的其他 exports（`useAPIKeys`、`useAPIHost`、`useAPIProvider`、`useTemperature`）仍在使用，保留。

---

## 不在本次範圍內

- 並行數（concurrency）調整 UI：本地 LLM 可透過 delay 控制速率，暫不新增
- 手動編輯翻譯失敗行：UI 暫不提供，等使用者需求確認後再設計
- preload script 重構（LoadingManager）：功能正常，與本次目標無關
