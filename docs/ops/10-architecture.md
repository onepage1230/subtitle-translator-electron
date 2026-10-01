# 10 — 架構導覽（自 CLAUDE.md 抽出）

> **單一來源原則**：行為以程式碼為準，本檔只是導覽地圖。若發現本檔與程式碼不符，以程式碼為準並更新本檔。改功能時**不需要**在這裡同步散文描述——查細節請用 codegraph（`codegraph_context`）或直接讀對應模組。

Electron + React 桌面應用（Vite 建置），兩個執行環境：

## Electron 主程序（`electron/main/`）

| 檔案 | 職責 |
|---|---|
| `index.ts` | BrowserWindow 設定 + IPC handlers（`batch-translate`、`get-analysis`、`get-translated-content`、`get-subtitle-preview`、`check-analysis-cache`、`retry-file`），實際工作委派給下面四個模組 |
| `utils/translate.ts` | 只做 AI 呼叫：Vercel AI SDK（`@ai-sdk/openai-compatible`）chunk／單行翻譯，tool-calling 失敗時 fallback 到 JSON 輸出 |
| `utils/jsonOutput.ts` | 結構化輸出一律 `generateJson`（`generateText` + 寬鬆 parser + zod），**不用 `generateObject`**：本機模型不支援 structuredOutputs，SDK 會改送 `response_format: json_object`，oMLX 在某些輸入上穩定回 `[1.0]` |
| `utils/subtitle.ts` | 字幕解析／序列化：`parseSubtitle`（SRT/VTT/ASS/SSA）、`saveTranslated`（`.tmp` rename 原子寫入）、`normalizeCues`、`splitIntoChunk` |
| `utils/analysis.ts` | 前置分析與快取：`getOrCreateAnalysis`（3 段平行分析，每段只注入本段出現的劇集詞條；格式錯誤的原始回應寫 `<檔名>.analysis-failures.log`）、`hashContent`、`analysisCachePath`、`formatAnalysisContext` |
| `utils/pipeline.ts` | 翻譯流程編排：`translateFile`（parse → analyze → chunk → 平行翻譯 + 滑動 context window → 行級 fallback → save）、`retryTranslate`（指數退避）、`isLocalModel` |
| `electron/shared/subtitleKey.ts` | `makeKey`：以時間戳識別 cue，主程序與 renderer 共用 |

## Renderer（`src/`）

- React 18 + React Router（hash 路由：`/`、`/settings`、`/about`）
- Redux Toolkit（`src/store/`）只管記憶體中的檔案清單，不持久化
- 其餘設定全部走 `localStorage`（`usehooks-ts` 的 `useLocalStorage`）；`src/hooks/useOpenAI.ts` 是設定 hooks 入口
- **`nodeIntegration: true`、`contextIsolation: false`**——renderer 可直接 `import { ipcRenderer } from "electron"`

## IPC 模式

Renderer 用 `ipcRenderer.invoke("batch-translate", { files, params })` 發起；主程序做檔案 I/O 與 AI 呼叫，進度用 `ipcRenderer.send("batch-progress", data)` 推回，renderer 以 `ipcRenderer.on("batch-progress", handler)` 接收。

## 翻譯 pipeline（主程序，共 9 步）

1. `parseSubtitle` 解析 → 過濾 cues
2. `analyzeSubtitlesForContext` 產生劇情摘要 + 詞彙表（部分段落失敗時 UI 顯示 n/3 段成功），作為 `[Context]` 前置到每個翻譯請求；摘要全文送出，詞彙表按該請求文字過濾（`filterGlossaryForText`）
3. `splitIntoChunk` 切成 20 句一組
4. 平行處理（`tiny-async-pool` 併發 10）+ 滑動 context window（chunk 前後 ±5 cues）
5. 每 chunk 先試 tool-calling，失敗 fallback 到 JSON 輸出（`generateJson`），再 fallback 到編號清單
6. `retryTranslate` 指數退避重試，網路／限流／schema 錯誤最多 5 次
7. 行數對不齊的 chunk 走逐行 fallback（`translateSubtitleSingle`）
7a. 新翻的句子做品質檢查（`utils/quality.ts`：簡體字／未翻／人名詞彙表程式比對，填了 `typesafe_api_key` 再加 Jev 檢查）；有硬傷者清空後走同一個逐行 fallback 重翻一次，失敗則保留原譯文
8. 每 chunk 完成即原子寫檔（`.tmp` rename），支援即時預覽
9. 輸出存成 `<原檔名>.translated.<副檔名>`，與原檔同目錄

## 劇集模式（series mode）

同資料夾的字幕檔共用累積詞彙表 `.series-glossary.json`（first-wins，上限 100 條，類別優先序 person > organization > place > term）。同資料夾檔案按自然檔名順序**循序**處理；不同資料夾平行。重置劇集詞彙表：刪 `.series-glossary.json` **且**重新分析各集（reanalyze 對話框，或刪各檔 `.analysis.json` 快取），否則快取會把舊詞條灌回來。

## 設定持久化（localStorage keys）

`api_keys`（API key 字串陣列）、`api_host`（預設 `https://api.openai.com/v1`）、`api_provider`（`openrouter | openai | vercel-gateway | openai-compatible`）、`model`（預設 `gpt-4-turbo`）、`translate_lang`、`translate_additional`、`ai_temperature`（預設 1）、`multi_language_save`（`none | translate+original | original+translate`）、`typesafe_api_key`（選填，TypeSafe Jev 品質檢查）、`analysis_thinking_mode`（`keep | light | off`，預設 `light`：段落分析保留 thinking、調和與合成送 `chat_template_kwargs.enable_thinking=false`；段落分析關 thinking 會搞錯人物關係）

## 字幕格式與建置輸出

- `.srt`、`.vtt` → `subtitle` 套件；`.ass`、`.ssa` → `ass-parser` / `ass-stringify`
- `dist/`（Vite renderer）、`dist-electron/`（主程序 + preload）、`release/`（dmg/nsis/AppImage）——三者都是建置產物，**禁止直接編輯**（PreToolUse hook 會擋）
