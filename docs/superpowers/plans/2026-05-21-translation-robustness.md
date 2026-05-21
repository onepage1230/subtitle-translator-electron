# Translation Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修復本地 LLM schema 錯誤導致整個檔案中止、翻譯無法接續、delay 設定無效，並清理死碼。

**Architecture:** 在 `translateSubtitleChunk` 新增第三層純文字 fallback；在 `chunkProcessor` 加 try/catch 隔離 chunk 錯誤並追蹤失敗行的時間戳 key；在 `processFile` 開頭讀取已存在的翻譯檔來預填 `translatedText`，讓 `splitIntoChunk` 自動跳過；UI 在檔案列表顯示失敗行數，modal 以橙色標示。

**Tech Stack:** TypeScript、Electron IPC、Vercel AI SDK (`ai`, `@ai-sdk/openai-compatible`)、React、Redux Toolkit、tiny-async-pool

---

## 檔案異動清單

| 動作 | 路徑 | 說明 |
|------|------|------|
| 修改 | `electron/main/utils/translate.ts` | 新增 `parseNumberedList`、修改 `translateSubtitleChunk`（三層 fallback）、修復 `saveTranslated`（`__FAILED__` 處理） |
| 修改 | `electron/main/index.ts` | 提取 `makeKey` 至模組層級、新增 resume 邏輯、chunk 錯誤隔離、failedKeys 追蹤、delay 修復、done 事件加 failedCues/failedKeys |
| 修改 | `src/components/TranslatorPanel.tsx` | `ProgressType` 加 failedCues/failedKeys、file list 顯示失敗行數、modal 橙色標示 |
| 修改 | `src/locales/en-US.json` | 新增 `translate.line_failed`、`translate.done_with_failures` |
| 修改 | `src/locales/zh-TW.json` | 同上 |
| 修改 | `src/locales/zh-CN.json` | 同上 |
| 刪除 | `src/store/step.ts` | 死碼：stepSlice 從未使用 |
| 修改 | `src/store.ts` | 移除 stepReducer import 及 `step:` 欄位 |
| 修改 | `src/hooks/useOpenAI.ts` | 移除 `useTranslate` 函式 |

---

## Task 1：新增 `parseNumberedList` + 修改 `translateSubtitleChunk` 三層 fallback

**Files:**
- Modify: `electron/main/utils/translate.ts`

- [ ] **Step 1：在 `translate.ts` 中找到 `translateSubtitleChunk` 的結尾，在其前方加入 `parseNumberedList` 輔助函式**

在 `async function translateSubtitleChunk` 定義之前插入：

```typescript
function parseNumberedList(text: string, expectedCount: number): string[] | null {
  const lines: string[] = [];
  const regex = /^\d+\.\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    lines.push(match[1].trim());
  }
  return lines.length === expectedCount ? lines : null;
}
```

- [ ] **Step 2：將 `translateSubtitleChunk` 整個函式替換為三層 fallback 結構**

新函式結構（完整替換原本的 `async function translateSubtitleChunk(...)`）：

```typescript
async function translateSubtitleChunk(
  subtitles: string[],
  {
    apiKeys,
    apiHost,
    model,
    prompt,
    lang,
    additional,
    temperature,
  }: {
    apiKeys: string[];
    apiHost: string;
    model: string;
    prompt: string;
    lang: string;
    additional: string;
    temperature: number;
  }
) {
  if (apiKeys.length === 0) {
    throw new Error("No valid API keys provided");
  }

  const ai = getAi({ apiKey: apiKeys[0], apiHost });

  const systemPrompt = prompt
    .replaceAll("{{lang}}", lang)
    .replaceAll("{{additional}}", additional);

  // Layer 1: Tool calling
  let toolTranslated: string[] | null = null;
  try {
    const tools = {
      submit_translation: tool({
        description:
          "Provide the final translated subtitles. Keep order and length identical to input.",
        inputSchema: z
          .object({
            translated: z.array(
              z.string().describe("Translated subtitle at the same index")
            ),
          })
          .strict(),
        execute: async ({ translated }) => {
          toolTranslated = translated;
          return JSON.stringify(translated);
        },
      }),
    } as const;

    await generateText({
      model: ai(model),
      temperature,
      tools,
      toolChoice: "required",
      system:
        systemPrompt +
        "\nReturn ONLY using the tool, do not include any extra text.",
      prompt:
        "Translate the following subtitles. Return the result via the tool as an array of strings with the exact same length and order as input.\n\n" +
        JSON.stringify(subtitles),
      maxRetries: 2,
    });
  } catch {
    // Layer 1 failed silently, fall through to layer 2
  }

  if (
    toolTranslated &&
    Array.isArray(toolTranslated) &&
    toolTranslated.length === subtitles.length
  ) {
    return toolTranslated;
  }

  // Layer 2: JSON object generation
  try {
    const { object } = await generateObject({
      model: ai(model),
      temperature,
      schema: z.array(z.string().describe("The translated subtitles")),
      prompt:
        systemPrompt +
        "\nOutput must be valid json. Respond with a JSON object that matches the schema. Return only JSON.\n\n" +
        JSON.stringify(subtitles),
      maxRetries: 3,
    });
    if (Array.isArray(object) && object.length === subtitles.length) {
      return object;
    }
  } catch {
    // Layer 2 failed silently, fall through to layer 3
  }

  // Layer 3: Plain text numbered list
  const numberedResult = await generateText({
    model: ai(model),
    temperature,
    system:
      systemPrompt +
      "\nYou MUST reply ONLY with a numbered list. No explanations, no extra text.",
    prompt:
      "Translate each subtitle line. Reply ONLY in this exact format:\n1. [translation]\n2. [translation]\n...\n\nLines to translate:\n" +
      subtitles.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    maxRetries: 2,
  });

  const parsed = parseNumberedList(numberedResult.text, subtitles.length);
  if (parsed) return parsed;

  throw new Error(
    `Translation validation failed: all three layers produced wrong line count (expected ${subtitles.length})`
  );
}
```

- [ ] **Step 3：確認 `parseNumberedList` 和 `translateSubtitleChunk` 都在 `export { ... }` 中（`parseNumberedList` 不需要 export，確認沒有意外加入即可）**

檢查檔案末尾 export 區塊，應只有：
```typescript
export {
  translateSubtitleChunk,
  translateSubtitleSingle,
  parseSubtitle,
  saveTranslated,
  splitIntoChunk,
  analyzeSubtitlesForContext,
};
```

- [ ] **Step 4：執行 TypeScript 型別檢查確認無錯誤**

```bash
cd /Users/onepage/Documents/github/subtitle-translator-electron
npx tsc --noEmit
```

預期：無錯誤輸出

- [ ] **Step 5：Commit**

```bash
git add electron/main/utils/translate.ts
git commit -m "feat(translate): add three-layer fallback for local LLM schema failures"
```

---

## Task 2：修復 `saveTranslated` 的 `__FAILED__` 處理

**Files:**
- Modify: `electron/main/utils/translate.ts`

- [ ] **Step 1：在 `saveTranslated` 中找到 SRT/VTT 的 map 區段，修改 `translatedText` 取值邏輯**

找到這段（出現兩次，SRT/VTT 和 ASS 各一）：
```typescript
x.data.translatedText || x.data.text
```

SRT/VTT 的完整 map 呼叫約在第 254 行附近：
```typescript
newSubtitle = stringifySync(
  parsedSubtitle.map((x) => {
    return {
      type: x.type,
      data: {
        ...x.data,
        text: parseTranslatedText(
          x.data.text,
          x.data.translatedText || x.data.text   // ← 這裡
        ),
      },
    };
  }),
  { format }
);
```

替換為：
```typescript
newSubtitle = stringifySync(
  parsedSubtitle.map((x) => {
    return {
      type: x.type,
      data: {
        ...x.data,
        text: parseTranslatedText(
          x.data.text,
          (x.data.translatedText === "__FAILED__" ? "" : x.data.translatedText) || x.data.text
        ),
      },
    };
  }),
  { format }
);
```

- [ ] **Step 2：修復 ASS/SSA 的相同問題**

找到 ASS 區段中的 `translatedText || line.value.Text`（約在第 283 行）：
```typescript
const translatedText =
  currentEvent && currentEvent.data
    ? currentEvent.data.translatedText || line.value.Text
    : line.value.Text;
```

替換為：
```typescript
const rawTranslated =
  currentEvent && currentEvent.data
    ? currentEvent.data.translatedText
    : undefined;
const translatedText =
  rawTranslated === "__FAILED__" || !rawTranslated
    ? line.value.Text
    : rawTranslated;
```

- [ ] **Step 3：型別檢查**

```bash
npx tsc --noEmit
```

預期：無錯誤

- [ ] **Step 4：Commit**

```bash
git add electron/main/utils/translate.ts
git commit -m "fix(translate): prevent __FAILED__ sentinel from being written to output file"
```

---

## Task 3：提取 `makeKey` 至模組層級 + 新增 Resume 邏輯

**Files:**
- Modify: `electron/main/index.ts`

- [ ] **Step 1：在 `index.ts` 最上方的 import 區塊之後，新增模組層級的 `makeKey` 函式**

在 `process.env.DIST_ELECTRON = ...` 之前插入：

```typescript
function makeKey(start: any, end: any): string {
  const norm = (v: any) =>
    typeof v === "number" ? Math.round(v) : String(v).trim();
  return `${norm(start)}|${norm(end)}`;
}
```

- [ ] **Step 2：更新 `get-subtitle-preview` handler 改用模組層級的 `makeKey`**

找到 handler 內的 inline `makeKey` 定義（約第 546 行）：
```typescript
const makeKey = (start: any, end: any) => {
  const norm = (v: any) =>
    typeof v === "number" ? Math.round(v) : String(v).trim();
  return `${norm(start)}|${norm(end)}`;
};
```

直接刪除這段（因為模組層級已有同名函式），其餘 `makeKey(...)` 呼叫不需改動。

- [ ] **Step 3：在 `processFile` 的 `outputPath` 計算之後，插入 resume 邏輯**

找到：
```typescript
const outputPath = path.join(
  path.dirname(file.path),
  file.name.replace(/\.[^/.]+$/, "") + ".translated." + ext
);
```

在這段之後（在 analysis 開始之前）插入：

```typescript
// Resume: pre-populate translatedText from existing translated file
if (fs.existsSync(outputPath)) {
  try {
    const existingContent = fs.readFileSync(outputPath, "utf8");
    let existingParsed = parseSubtitle(existingContent, ext);
    let existingCues: any[];
    if (Array.isArray(existingParsed)) {
      existingCues = existingParsed.filter((l: any) => l.type === "cue");
    } else if ((existingParsed as any).events) {
      existingCues = (existingParsed as any).events;
    } else {
      existingCues = existingParsed as any[];
    }
    const resumeMap = new Map<string, string>();
    existingCues.forEach((cue: any) => {
      if (cue.data) {
        resumeMap.set(makeKey(cue.data.start, cue.data.end), cue.data.text || "");
      }
    });
    subtitle.forEach((cue: any) => {
      const key = makeKey(cue.data.start, cue.data.end);
      const existingText = resumeMap.get(key);
      // Only pre-populate if translated text differs from original (avoids treating __FAILED__ lines as done)
      if (existingText !== undefined && existingText !== cue.data.text) {
        cue.data.translatedText = existingText;
      }
    });
  } catch (resumeErr) {
    console.warn("Resume pre-population failed, starting fresh:", resumeErr);
  }
}
```

- [ ] **Step 4：型別檢查**

```bash
npx tsc --noEmit
```

預期：無錯誤

- [ ] **Step 5：Commit**

```bash
git add electron/main/index.ts
git commit -m "feat(translate): add resume logic to skip already-translated cues on restart"
```

---

## Task 4：Chunk 層級錯誤隔離 + failedKeys 追蹤

**Files:**
- Modify: `electron/main/index.ts`

- [ ] **Step 1：在 `processFile` 中，於 `let chunks = splitIntoChunk(...)` 之前加入 `failedKeys` Set**

找到：
```typescript
let chunks = splitIntoChunk(subtitle, 20);
```

在其之前插入：
```typescript
const failedKeys = new Set<string>();
```

- [ ] **Step 2：在 attempt loop（`for (let attempt = 1; attempt <= 3; attempt++)`）外層加入 try/catch，並在 catch 中將 block 的每一行標記為 `__FAILED__`**

找到 `chunkProcessor` 函式的完整定義，將其 `async (block) => {` 的整個函式體包進 try/catch：

```typescript
const chunkProcessor = async (block) => {
  try {
    // 以原始索引建立「核心段」和「上下文視窗」
    const contextSize =
      typeof params.contextSize === "number" ? params.contextSize : 5;

    const coreIndices = block
      .map((cue: any) => indexMap.get(cue) as number)
      .filter((n: number) => typeof n === "number")
      .sort((a: number, b: number) => a - b);

    if (coreIndices.length === 0) return;

    const coreStart = coreIndices[0];
    const coreEnd = coreIndices[coreIndices.length - 1];

    const contextStart = Math.max(0, coreStart - contextSize);
    const contextEnd = Math.min(subtitle.length - 1, coreEnd + contextSize);

    const windowCues = subtitle.slice(contextStart, contextEnd + 1);
    const windowText = windowCues.map((c: any) =>
      c && c.data ? String(c.data.text).replaceAll(/\n/g, " ").trim() : ""
    );

    let translatedWindow: string[] | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const baseTemp =
        typeof params.temperature === "number" ? params.temperature : 1;
      const attemptTemp = Math.max(
        0.1,
        Math.min(2, baseTemp + (Math.random() - 0.5) * 0.4)
      );
      try {
        const attemptResult = await retryTranslate(
          async (chunkText) =>
            translateSubtitleChunk(chunkText, {
              ...params,
              apiKeys: params.apiKeys || [],
              apiHost: params.apiHost || "https://api.openai.com/v1",
              model: params.model || "",
              prompt: params.prompt || "",
              lang: params.lang || "",
              additional: combinedAdditional || "",
              temperature: attemptTemp,
            }),
          windowText
        );
        if (attempt > 1) {
          console.log(
            `Chunk attempt ${attempt} (context window) done, temp=${attemptTemp}`
          );
        }
        if (
          Array.isArray(attemptResult) &&
          attemptResult.length === windowText.length
        ) {
          translatedWindow = attemptResult;
          break;
        }
      } catch {
        // attempt failed, try next or fall through to line-by-line
      }
    }

    // 逐句 fallback：僅翻譯核心行，並填回對應視窗位置
    if (!translatedWindow) {
      translatedWindow = new Array(windowText.length).fill(null);
      for (let i = 0; i < coreIndices.length; i++) {
        const idx = coreIndices[i];
        const lineText =
          subtitle[idx] && subtitle[idx].data ? subtitle[idx].data.text : "";
        try {
          const single = await retryTranslate(
            async (singleText) =>
              translateSubtitleSingle(singleText, {
                ...params,
                apiKeys: params.apiKeys || [],
                apiHost: params.apiHost || "https://api.openai.com/v1",
                model: params.model || "",
                prompt: params.prompt || "",
                lang: params.lang || "",
                additional: combinedAdditional || "",
                temperature:
                  typeof params.temperature === "number"
                    ? params.temperature
                    : 1,
              }),
            lineText
          );
          translatedWindow[idx - contextStart] = single;
        } catch {
          translatedWindow[idx - contextStart] = null;
        }
      }
    }

    // 只回寫核心段的翻譯（丟棄上下文前後行）
    let chunkCompleted = 0;
    for (const cue of block) {
      const idx = indexMap.get(cue) as number;
      if (typeof idx !== "number") continue;
      const offset = idx - contextStart;
      const t =
        translatedWindow &&
        translatedWindow[offset] != null &&
        typeof translatedWindow[offset] === "string"
          ? translatedWindow[offset]
          : "";
      if (cue && cue.data) {
        cue.data.translatedText = t;
        chunkCompleted++;
      }
    }

    completedCues += chunkCompleted;
    const progress = 10 + (completedCues / totalCues) * 90;
    const currentCue = Math.min(completedCues, totalCues);
    event.sender.send("batch-progress", {
      filePath: file.path,
      progress: Math.min(progress, 90),
      status: "translating",
      totalCues,
      currentCue,
      analysis: analysisData,
    });

    // 寫入部分成果供即時預覽
    try {
      saveTranslated(
        outputPath,
        parsed,
        ext,
        params.multiLangSave || "none"
      );
    } catch (e) {
      console.warn("Failed to write partial translated file:", e);
    }

    // Delay between chunks
    if (params.delay && params.delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, params.delay));
    }
  } catch (chunkErr) {
    // Chunk-level isolation: mark all lines in this block as failed
    console.warn("Chunk failed, marking lines as __FAILED__:", chunkErr);
    for (const cue of block) {
      if (cue && cue.data) {
        cue.data.translatedText = "__FAILED__";
        failedKeys.add(makeKey(cue.data.start, cue.data.end));
      }
    }
    try {
      saveTranslated(outputPath, parsed, ext, params.multiLangSave || "none");
    } catch {}
  }
};
```

> **注意：** 這個步驟同時完成了：（1）chunk 錯誤隔離、（2）attempt loop 加 try/catch、（3）line-by-line fallback 加 try/catch、（4）Delay 修復（見最後的 `if (params.delay ...)` 區塊）。

- [ ] **Step 3：更新 done 事件，加入 `failedCues` 和 `failedKeys`**

找到 `processFile` 末尾的最終 done 事件：
```typescript
event.sender.send("batch-progress", {
  filePath: file.path,
  progress: 100,
  status: "done",
  totalCues,
  currentCue: totalCues,
  analysis: analysisData,
});
```

替換為：
```typescript
event.sender.send("batch-progress", {
  filePath: file.path,
  progress: 100,
  status: "done",
  totalCues,
  currentCue: totalCues,
  analysis: analysisData,
  failedCues: failedKeys.size,
  failedKeys: Array.from(failedKeys),
});
```

- [ ] **Step 4：型別檢查**

```bash
npx tsc --noEmit
```

預期：無錯誤

- [ ] **Step 5：Commit**

```bash
git add electron/main/index.ts
git commit -m "feat(translate): chunk-level error isolation, failedKeys tracking, and delay fix"
```

---

## Task 5：更新 TranslatorPanel UI 顯示失敗行

**Files:**
- Modify: `src/components/TranslatorPanel.tsx`
- Modify: `src/locales/en-US.json`
- Modify: `src/locales/zh-TW.json`
- Modify: `src/locales/zh-CN.json`

- [ ] **Step 1：在三個 locale 檔案加入新 i18n key**

`src/locales/en-US.json`——在 `"not_translated_yet"` 後加入：
```json
"not_translated_yet": "Not translated yet",
"line_failed": "Translation failed",
"done_with_failures": "done ({{count}} lines failed) - 100.0%"
```

`src/locales/zh-TW.json`——同位置加入：
```json
"not_translated_yet": "尚未翻譯",
"line_failed": "翻譯失敗",
"done_with_failures": "完成（{{count}} 行翻譯失敗）- 100.0%"
```

`src/locales/zh-CN.json`——同位置加入：
```json
"not_translated_yet": "尚未翻译",
"line_failed": "翻译失败",
"done_with_failures": "完成（{{count}} 行翻译失败）- 100.0%"
```

> **注意：** 先確認 `zh-TW.json` 中 `"not_translated_yet"` 的現有值，只加新的兩個 key，不要重複。

- [ ] **Step 2：更新 `ProgressType` interface，加入 `failedCues` 和 `failedKeys`**

找到 `TranslatorPanel.tsx` 中的：
```typescript
interface ProgressType {
  progress: number;
  status: "pending" | "analyzing" | "translating" | "done" | "error";
  error?: string;
  totalCues?: number;
  currentCue?: number;
  analysis?: string;
}
```

替換為：
```typescript
interface ProgressType {
  progress: number;
  status: "pending" | "analyzing" | "translating" | "done" | "error";
  error?: string;
  totalCues?: number;
  currentCue?: number;
  analysis?: string;
  failedCues?: number;
  failedKeys?: string[];
}
```

- [ ] **Step 3：更新 statusText 計算邏輯，在 done 時顯示失敗行數**

找到：
```typescript
let statusText = "";
if (
  progressData.status === "translating" &&
  progressData.currentCue &&
  progressData.totalCues
) {
  statusText = `Translating cue ${progressData.currentCue} of ${
    progressData.totalCues
  } - ${progressData.progress.toFixed(1)}%`;
} else if (progressData.status === "analyzing") {
  statusText = `${t("translate.analyzing_context")} - ${progressData.progress.toFixed(1)}%`;
} else {
  statusText = `${progressData.status} - ${progressData.progress.toFixed(1)}%`;
}
```

替換為：
```typescript
let statusText = "";
if (progressData.status === "done") {
  statusText =
    progressData.failedCues && progressData.failedCues > 0
      ? t("translate.done_with_failures", { count: progressData.failedCues })
      : `done - 100.0%`;
} else if (
  progressData.status === "translating" &&
  progressData.currentCue &&
  progressData.totalCues
) {
  statusText = `Translating cue ${progressData.currentCue} of ${
    progressData.totalCues
  } - ${progressData.progress.toFixed(1)}%`;
} else if (progressData.status === "analyzing") {
  statusText = `${t("translate.analyzing_context")} - ${progressData.progress.toFixed(1)}%`;
} else {
  statusText = `${progressData.status} - ${progressData.progress.toFixed(1)}%`;
}
```

- [ ] **Step 4：在 modal 開啟前計算 failedKeySet，並在 modal 的 cue 渲染中加橙色標示**

在 `TranslatorPanel` component 的 return 中，找到 modal 的 `{cues.map((cue: any, index: number) => (` 前方，加入：

```typescript
const failedKeySet = new Set<string>(
  selectedFile ? (batchProgress[selectedFile.path]?.failedKeys || []) : []
);
const makeCueKey = (start: any, end: any): string => {
  const norm = (v: any) =>
    typeof v === "number" ? Math.round(v) : String(v).trim();
  return `${norm(start)}|${norm(end)}`;
};
```

然後找到：
```typescript
{cues.map((cue: any, index: number) => (
  <div
    key={index}
    className="border border-gray-300 p-1 px-2 mb-1 rounded"
  >
    <div>{cue.text}</div>
    <div className="text-sm opacity-75">
      {cue.translatedText || t("translate.not_translated_yet")}
    </div>
  </div>
))}
```

替換為：
```typescript
{cues.map((cue: any, index: number) => {
  const isFailed = failedKeySet.has(makeCueKey(cue.start, cue.end));
  return (
    <div
      key={index}
      className={`p-1 px-2 mb-1 rounded border ${
        isFailed
          ? "border-orange-300 bg-orange-50"
          : "border-gray-300"
      }`}
    >
      <div>{cue.text}</div>
      <div
        className={`text-sm ${
          isFailed ? "text-orange-500" : "opacity-75"
        }`}
      >
        {isFailed
          ? t("translate.line_failed")
          : cue.translatedText || t("translate.not_translated_yet")}
      </div>
    </div>
  );
})}
```

- [ ] **Step 5：型別檢查**

```bash
npx tsc --noEmit
```

預期：無錯誤

- [ ] **Step 6：Commit**

```bash
git add src/components/TranslatorPanel.tsx src/locales/en-US.json src/locales/zh-TW.json src/locales/zh-CN.json
git commit -m "feat(ui): show failed line count and orange highlight for failed cues in modal"
```

---

## Task 6：死碼清理

**Files:**
- Delete: `src/store/step.ts`
- Modify: `src/store.ts`
- Modify: `src/hooks/useOpenAI.ts`

- [ ] **Step 1：刪除 `src/store/step.ts`**

```bash
rm src/store/step.ts
```

- [ ] **Step 2：更新 `src/store.ts`，移除 step 相關內容**

找到現有的 `src/store.ts`：
```typescript
import { configureStore } from "@reduxjs/toolkit";
import stepReducer from "./store/step";
import fileReducer from "./store/file";
export default configureStore({
  reducer: {
    step: stepReducer,
    file: fileReducer,
  },
});
```

替換為：
```typescript
import { configureStore } from "@reduxjs/toolkit";
import fileReducer from "./store/file";
export default configureStore({
  reducer: {
    file: fileReducer,
  },
});
```

- [ ] **Step 3：移除 `src/hooks/useOpenAI.ts` 中的 `useTranslate` 函式**

找到並刪除整個 `useTranslate` 函式區塊（從 `export function useTranslate()` 到對應的結尾 `}`）。保留檔案其餘部分：`useAPIKeys`、`useAPIHost`、`useAPIProvider`、`useTemperature`。

移除後，`useOpenAI.ts` 的 import 區塊應只剩：
```typescript
import { useLocalStorage } from "usehooks-ts";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
```

（確認 `z`、`generateObject`、`generateText`、`tool` 的 import 也一併移除，因為只有 `useTranslate` 使用它們）

- [ ] **Step 4：型別檢查確認無殘留引用**

```bash
npx tsc --noEmit
```

預期：無錯誤，無 `step`、`useTranslate` 相關 import 錯誤

- [ ] **Step 5：Commit**

```bash
git add src/store.ts src/hooks/useOpenAI.ts
git rm src/store/step.ts
git commit -m "chore: remove unused step Redux slice and renderer-side useTranslate"
```

---

## 驗收檢查

執行以下手動驗證，對應 spec 的驗收標準：

**Resume：**
1. 選擇一個較長的字幕檔，開始翻譯
2. 翻譯至約 50% 時按 Cmd+Q 強制關閉應用程式
3. 重新啟動，選擇同一個檔案，按開始翻譯
4. 預期：進度條不從 0% 開始，已翻譯行跳過，直接繼續未完成部分

**Fallback + 錯誤隔離：**
1. 設定 oMLX 為 API host
2. 翻譯任一字幕檔
3. 預期：即使部分 chunk 失敗，整個檔案仍完成（不中止）
4. 點開檔案的 modal，失敗行顯示橙色「Translation failed」

**Delay：**
1. 在 Settings 設定 Delay 為 `2`（秒）
2. 開始翻譯並查看 Electron main process 的 log（終端機）
3. 預期：可觀察到 chunk 間有明顯停頓，約每 2 秒一個 chunk

**死碼清理：**
```bash
npx tsc --noEmit
# 預期：無錯誤
grep -r "stepReducer\|useTranslate\|nextStep\|previousStep" src/
# 預期：無輸出
```
