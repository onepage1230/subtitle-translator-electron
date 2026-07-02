# Main Process 重構、劇集模式、失敗行重試 — 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 將 `electron/main/index.ts` 的 450 行 `batch-translate` 單體拆為可測試模組，在此地基上實作劇集共用詞彙表與失敗行重試。

**Architecture:** Phase 1 以「機械式抽離 + 特徵測試鎖定行為」的順序重構：先把 `processFile` 原樣搬進 `pipeline.ts`（唯一改動：`event.sender.send` → `onProgress` callback），用特徵測試鎖住進度事件序列後，再往下拆 `subtitle.ts` / `analysis.ts`。Phase 2 在 `analysis.ts` 邊界上加掛劇集詞彙表（`.series-glossary.json`，同資料夾累積、先到者勝、100 條上限）。Phase 3 重用 resume 機制實作失敗行重試（`retry-file` IPC = 單檔重跑）。

**Tech Stack:** Electron 38 + Vite 7 + React 18、Vercel AI SDK（`ai` + `@ai-sdk/openai-compatible`）、zod、vitest（本計畫引入）、pnpm。

**Spec:** `docs/superpowers/specs/2026-07-02-refactor-series-mode-retry-design.md`

## Global Constraints

- **`batch-progress` 事件 payload 全程維持相容**：欄位 `filePath, progress, status, totalCues, currentCue, analysis, error, failedCues, failedKeys` 的名稱、型別、語意不得改變。
- **不動 Electron 安全設定**：`nodeIntegration: true` / `contextIsolation: false` 維持現狀（使用者明確排除）。
- **共用程式碼放 `electron/shared/`**，不是根目錄 `shared/`——`vite-electron-plugin` 的 `include: ["electron"]` 只編譯 `electron/` 下的檔案；renderer 由 Vite 直接編譯同一份原始碼。
- **測試檔一律放根目錄 `tests/unit/`**，不可與 `electron/` 源碼同層——否則 `*.test.ts` 會被 vite-electron-plugin 編進 `dist-electron` 打包產物。
- **pnpm 11 打包注意**：新增「runtime」依賴必須明確加入 `dependencies`（間接依賴不會 hoist）。本計畫只新增 devDependency（vitest），無打包影響；若執行中發現需要新 runtime 依賴，先讀 `~/.claude/projects/-Users-onepage-Documents-github-subtitle-translator-electron/memory/feedback-pnpm11-packaging.md`。
- **i18n 三語系同步**：新增 UI 字串必須同時加入 `src/locales/en-US.json`、`zh-TW.json`、`zh-CN.json`（結構：檔案根 `translation` 物件之下）。
- **commit 切分**：行為變更與純搬移重構不得混在同一個 commit。
- **驗證指令**：單元測試 `npx vitest run`；renderer 型別檢查 `npx tsc`（root tsconfig 只涵蓋 `src/`；`electron/` 的型別錯誤靠 vitest 執行與 `npm run pree2e` 的建置把關）。

---

## Phase 1：重構 main process

### Task 1: vitest 基礎設施 + 共用 makeKey

**Files:**
- Create: `vitest.config.ts`
- Create: `electron/shared/subtitleKey.ts`
- Create: `tests/unit/subtitleKey.test.ts`
- Modify: `package.json`（scripts 加 `test`）
- Modify: `electron/main/index.ts:19-23`（刪除本地 makeKey，改 import）
- Modify: `src/components/TranslatorPanel.tsx:284-288`（刪除本地 makeCueKey，改 import）

**Interfaces:**
- Produces: `makeKey(start: unknown, end: unknown): string` — 之後所有任務以 `import { makeKey } from "<相對路徑>/electron/shared/subtitleKey"` 使用。

- [ ] **Step 1: 安裝 vitest**

```bash
pnpm add -D vitest
```

- [ ] **Step 2: 建立 vitest.config.ts**

獨立設定檔（不能讓 vitest 去載入 `vite.config.ts`——那個檔案在載入時會 `rmSync("dist-electron")` 造成副作用）：

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

`package.json` scripts 加入：

```json
"test": "vitest run"
```

- [ ] **Step 3: 寫失敗測試**

```ts
// tests/unit/subtitleKey.test.ts
import { describe, it, expect } from "vitest";
import { makeKey } from "../../electron/shared/subtitleKey";

describe("makeKey", () => {
  it("rounds numeric timestamps", () => {
    expect(makeKey(1000.4, 2000.6)).toBe("1000|2001");
  });
  it("trims string timestamps", () => {
    expect(makeKey(" 0:00:01.00 ", "0:00:02.00")).toBe("0:00:01.00|0:00:02.00");
  });
  it("mixed types", () => {
    expect(makeKey(1500, " a ")).toBe("1500|a");
  });
});
```

- [ ] **Step 4: 執行測試確認失敗**

Run: `npx vitest run tests/unit/subtitleKey.test.ts`
Expected: FAIL（模組不存在）

- [ ] **Step 5: 建立共用模組**

內容 = `electron/main/index.ts:19-23` 的 makeKey 原樣搬移：

```ts
// electron/shared/subtitleKey.ts
export function makeKey(start: unknown, end: unknown): string {
  const norm = (v: unknown) =>
    typeof v === "number" ? Math.round(v) : String(v).trim();
  return `${norm(start)}|${norm(end)}`;
}
```

- [ ] **Step 6: 改寫兩處使用端**

`electron/main/index.ts`：刪除第 19–23 行的 `makeKey` 函式，最上方加：

```ts
import { makeKey } from "../shared/subtitleKey";
```

`src/components/TranslatorPanel.tsx`：刪除第 284–288 行的 `makeCueKey`，import 區加：

```ts
import { makeKey } from "../../electron/shared/subtitleKey";
```

並把該檔中唯一的呼叫點 `makeCueKey(cue.start, cue.end)`（約第 533 行）改為 `makeKey(cue.start, cue.end)`。

- [ ] **Step 7: 驗證**

Run: `npx vitest run tests/unit/subtitleKey.test.ts` → PASS
Run: `npx tsc` → 無錯誤

- [ ] **Step 8: Commit**

```bash
git add vitest.config.ts package.json pnpm-lock.yaml electron/shared/subtitleKey.ts tests/unit/subtitleKey.test.ts electron/main/index.ts src/components/TranslatorPanel.tsx
git commit -m "refactor: extract shared makeKey, add vitest infrastructure"
```

---

### Task 2: pipeline.ts 機械式抽離 + 特徵測試

`processFile`（`electron/main/index.ts:256-694`）與其依賴的純函式原樣搬進 `pipeline.ts`。**唯一允許的邏輯改動**：`event.sender.send("batch-progress", X)` → `onProgress(X)`（共 8 處），以及移除 `analysisCache.set(...)` 一行（快取責任留在 index.ts）。搬完立刻用特徵測試鎖定行為。

**Files:**
- Create: `electron/main/utils/pipeline.ts`
- Create: `tests/unit/pipeline.characterization.test.ts`
- Modify: `electron/main/index.ts`（handler 縮為薄層）

**Interfaces:**
- Consumes: `makeKey`（Task 1）；`translate.ts` 現有 export。
- Produces（後續任務依賴的簽名）:
  - `translateFile(file: { path: string; name: string }, params: TranslateParams, onProgress: (data: ProgressEvent) => void): Promise<void>`
  - `retryTranslate(fn, params, maxRetries?, delay?)`、`isLocalModel(apiHost: string): boolean`、`hashContent(content: string): string`、`mergeGlossaries(...)`、`formatAnalysisContext(...)`（暫居 pipeline.ts，Task 4 再移往 analysis.ts）
  - 型別：

```ts
export interface TranslateParams {
  apiKeys: string[];
  apiHost?: string;
  model?: string;
  prompt?: string;
  lang?: string;
  additional?: string;
  temperature?: number;
  multiLangSave?: string;
  delay?: number;
  contextSize?: number;
  concurrentRequests?: number;
  forceReanalyze?: boolean;
}

export interface ProgressEvent {
  filePath: string;
  progress: number;
  status: "translating" | "analyzing" | "done" | "error";
  totalCues?: number;
  currentCue?: number;
  analysis?: AnalysisResult | null;
  error?: string;
  failedCues?: number;
  failedKeys?: string[];
}
```

- [ ] **Step 1: 建立 pipeline.ts（純搬移）**

檔案結構：

```ts
// electron/main/utils/pipeline.ts
import fs from "node:fs";
import path from "node:path";
import pool from "tiny-async-pool";
import { makeKey } from "../../shared/subtitleKey";
import type { AnalysisResult } from "./translate";
import {
  splitIntoChunk,
  parseSubtitle,
  translateSubtitleChunk,
  translateSubtitleSingle,
  saveTranslated,
  analyzeSubtitlesForContext,
  synthesizePlotSummaries,
} from "./translate";

// ↓ 以下區塊自 index.ts 原樣搬入（來源行號為 Task 1 完成後的 index.ts）：
//   hashContent、ANALYSIS_SECTIONS、mergeGlossaries、formatAnalysisContext、
//   isLocalModel（原 index.ts:155-188 一帶）
//   retryTranslate（原 index.ts:208-253）

export interface TranslateParams { /* 如上 Interfaces 區塊 */ }
export interface ProgressEvent { /* 如上 Interfaces 區塊 */ }

export async function translateFile(
  file: { path: string; name: string },
  params: TranslateParams,
  onProgress: (data: ProgressEvent) => void
): Promise<void> {
  // ← processFile 函式本體（原 index.ts:256-694）原樣貼入，僅做兩類替換：
  //   1. 全部 8 處 `event.sender.send("batch-progress", {...})` → `onProgress({...})`
  //   2. 刪除 `analysisCache.set(file.path, analysisData);` 一行
}

export { hashContent, mergeGlossaries, formatAnalysisContext, isLocalModel, retryTranslate };
```

- [ ] **Step 2: 縮減 index.ts**

刪除 index.ts 中已搬走的區塊（hashContent、ANALYSIS_SECTIONS、mergeGlossaries、formatAnalysisContext、isLocalModel、retryTranslate、processFile 本體），`batch-translate` handler 改為：

```ts
import { translateFile, hashContent } from "./utils/pipeline";

ipcMain.handle("batch-translate", async (event, { files, params }) => {
  const processFile = async (file) => {
    await translateFile(file, params, (data) => {
      if (data.analysis) analysisCache.set(data.filePath, data.analysis);
      event.sender.send("batch-progress", data);
    });
  };
  for await (const _ of pool(3, files, processFile)) {
    // Process all files in parallel with concurrency 3
  }
  return { success: true };
});
```

`check-analysis-cache` handler 改 import pipeline 的 `hashContent`。index.ts 不再需要的 import（`crypto`、translate.ts 的翻譯函式）一併移除；`parseSubtitle` 仍被 `get-subtitle-preview` 使用，保留。

- [ ] **Step 3: 寫特徵測試**

```ts
// tests/unit/pipeline.characterization.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../electron/main/utils/translate", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual, // parseSubtitle / saveTranslated / splitIntoChunk 用真實實作
    translateSubtitleChunk: vi.fn(),
    translateSubtitleSingle: vi.fn(),
    analyzeSubtitlesForContext: vi.fn(),
    synthesizePlotSummaries: vi.fn(),
  };
});

import { translateFile } from "../../electron/main/utils/pipeline";
import * as translate from "../../electron/main/utils/translate";

const SRT = `1
00:00:01,000 --> 00:00:02,000
Hello

2
00:00:03,000 --> 00:00:04,000
World

3
00:00:05,000 --> 00:00:06,000
Again
`;

const BASE_PARAMS = {
  apiKeys: ["k"],
  apiHost: "https://api.openai.com/v1",
  model: "m",
  prompt: "translate to {{lang}} {{additional}}",
  lang: "zh-TW",
  additional: "",
  temperature: 1,
};

function makeTmpSrt(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stx-"));
  const p = path.join(dir, "movie.srt");
  fs.writeFileSync(p, SRT, "utf8");
  return p;
}

function resetMocks() {
  vi.mocked(translate.translateSubtitleChunk).mockReset()
    .mockImplementation(async (subs: string[]) => subs.map((s) => `T:${s}`));
  vi.mocked(translate.translateSubtitleSingle).mockReset()
    .mockImplementation(async (s: string) => `T:${s}`);
  vi.mocked(translate.analyzeSubtitlesForContext).mockReset()
    .mockResolvedValue({
      plotSummary: "part-summary",
      glossary: [{ term: "Hello", translation: "哈囉" }],
    } as any);
  vi.mocked(translate.synthesizePlotSummaries).mockReset()
    .mockResolvedValue("combined-summary");
}

beforeEach(resetMocks);

describe("translateFile characterization", () => {
  it("emits expected progress sequence and writes translated output", async () => {
    const file = makeTmpSrt();
    const events: any[] = [];
    await translateFile({ path: file, name: "movie.srt" }, BASE_PARAMS, (e) =>
      events.push(e)
    );

    const statuses = events.map((e) => e.status);
    expect(statuses[0]).toBe("translating"); // progress 0 起手式
    expect(statuses).toContain("analyzing");
    expect(statuses[statuses.length - 1]).toBe("done");

    const last = events[events.length - 1];
    expect(last.progress).toBe(100);
    expect(last.totalCues).toBe(3);
    expect(last.currentCue).toBe(3);
    expect(last.failedCues).toBe(0);
    expect(last.failedKeys).toEqual([]);
    expect(last.analysis.plotSummary).toBe("combined-summary");

    // progress 單調不減
    for (let i = 1; i < events.length; i++) {
      expect(events[i].progress).toBeGreaterThanOrEqual(events[i - 1].progress);
    }

    const out = fs.readFileSync(
      file.replace(/\.srt$/, ".translated.srt"),
      "utf8"
    );
    expect(out).toContain("T:Hello");
    expect(out).toContain("T:World");
    expect(out).toContain("T:Again");

    // 分析快取已寫出
    expect(fs.existsSync(file.replace(/\.srt$/, ".analysis.json"))).toBe(true);
  });

  it("resume: keeps already-translated lines untouched", async () => {
    const file = makeTmpSrt();
    fs.writeFileSync(
      file.replace(/\.srt$/, ".translated.srt"),
      SRT.replace("Hello", "既譯"),
      "utf8"
    );
    await translateFile({ path: file, name: "movie.srt" }, BASE_PARAMS, () => {});

    const out = fs.readFileSync(
      file.replace(/\.srt$/, ".translated.srt"),
      "utf8"
    );
    expect(out).toContain("既譯"); // 已譯行未被覆蓋
    expect(out).not.toContain("T:Hello");
    expect(out).toContain("T:World");
    expect(out).toContain("T:Again");
  });

  it("falls back to line-by-line when chunk translation keeps failing", async () => {
    // 不可重試錯誤（訊息不含 network/timeout 等關鍵字）→ 快速走完 3 次 attempt
    vi.mocked(translate.translateSubtitleChunk).mockRejectedValue(
      new Error("boom")
    );
    const file = makeTmpSrt();
    const events: any[] = [];
    await translateFile({ path: file, name: "movie.srt" }, BASE_PARAMS, (e) =>
      events.push(e)
    );

    expect(translate.translateSubtitleSingle).toHaveBeenCalledTimes(3);
    const last = events[events.length - 1];
    expect(last.status).toBe("done");
    expect(last.failedCues).toBe(0);

    const out = fs.readFileSync(
      file.replace(/\.srt$/, ".translated.srt"),
      "utf8"
    );
    expect(out).toContain("T:Hello");
  });

  it("analysis failure does not block translation", async () => {
    vi.mocked(translate.analyzeSubtitlesForContext).mockRejectedValue(
      new Error("analysis down")
    );
    const file = makeTmpSrt();
    const events: any[] = [];
    await translateFile({ path: file, name: "movie.srt" }, BASE_PARAMS, (e) =>
      events.push(e)
    );
    const last = events[events.length - 1];
    expect(last.status).toBe("done");
    expect(last.analysis).toBeFalsy();
  });
});
```

- [ ] **Step 4: 執行測試**

Run: `npx vitest run tests/unit/pipeline.characterization.test.ts`
Expected: PASS（若 FAIL，代表搬移過程改到了行為——回頭比對，**修 pipeline.ts 使其與原行為一致，不是改測試**）

- [ ] **Step 5: retryTranslate 單元測試（fake timers）**

```ts
// tests/unit/retryTranslate.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { retryTranslate } from "../../electron/main/utils/pipeline";

afterEach(() => {
  vi.useRealTimers();
});

describe("retryTranslate", () => {
  it("retries retryable errors with exponential backoff", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockRejectedValueOnce(new Error("rate limit exceeded"))
      .mockResolvedValue("ok");
    const promise = retryTranslate(fn, "input", 5, 1000);
    await vi.runAllTimersAsync();
    expect(await promise).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws non-retryable errors immediately", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("invalid api key"));
    await expect(retryTranslate(fn, "input", 5, 1)).rejects.toThrow("invalid api key");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting maxRetries", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(new Error("timeout"));
    const promise = retryTranslate(fn, "input", 3, 1000);
    const assertion = expect(promise).rejects.toThrow("timeout");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries on retryable HTTP status", async () => {
    vi.useFakeTimers();
    const err: any = new Error("server exploded");
    err.status = 500;
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");
    const promise = retryTranslate(fn, "input", 5, 1000);
    await vi.runAllTimersAsync();
    expect(await promise).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
```

Run: `npx vitest run tests/unit/retryTranslate.test.ts` → PASS

- [ ] **Step 6: 全部測試 + 型別**

Run: `npx vitest run` → PASS；`npx tsc` → 無錯誤

- [ ] **Step 7: Commit**

```bash
git add electron/main/utils/pipeline.ts electron/main/index.ts tests/unit/pipeline.characterization.test.ts tests/unit/retryTranslate.test.ts
git commit -m "refactor: extract translateFile pipeline from batch-translate handler"
```

---

### Task 3: subtitle.ts 拆分 + normalizeCues

**Files:**
- Create: `electron/main/utils/subtitle.ts`
- Create: `tests/unit/subtitle.test.ts`
- Modify: `electron/main/utils/translate.ts`（移出 parseSubtitle、saveTranslated、splitIntoChunk）
- Modify: `electron/main/utils/pipeline.ts`、`electron/main/index.ts`（改 import；三處形狀判斷改用 normalizeCues）

**Interfaces:**
- Produces:
  - `parseSubtitle(fileContent: string, fileExtension: string)`（原樣搬移）
  - `saveTranslated(outputPath, parsedSubtitle, fileExtension, multiLangSave?)`（原樣搬移）
  - `splitIntoChunk(array: any[], by?: number)`（原樣搬移）
  - `normalizeCues(parsed: any): any[]`（新函式）

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/unit/subtitle.test.ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseSubtitle,
  saveTranslated,
  splitIntoChunk,
  normalizeCues,
} from "../../electron/main/utils/subtitle";

const SRT = `1
00:00:01,000 --> 00:00:02,000
Hello

2
00:00:03,000 --> 00:00:04,000
World
`;

const ASS = `[Script Info]
Title: test

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello
Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,World
`;

function tmpFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stx-")), name);
}

describe("normalizeCues", () => {
  it("filters cue lines from srt/vtt array shape", () => {
    const cues = normalizeCues(parseSubtitle(SRT, "srt"));
    expect(cues).toHaveLength(2);
    expect(cues[0].data.text).toBe("Hello");
  });
  it("returns events from ass shape", () => {
    const cues = normalizeCues(parseSubtitle(ASS, "ass"));
    expect(cues).toHaveLength(2);
    expect(cues[1].data.text).toBe("World");
  });
  it("passes through an already-flat cue array", () => {
    const flat = [{ type: "cue", data: { text: "x" } }];
    expect(normalizeCues(flat)).toEqual(flat);
  });
});

describe("splitIntoChunk", () => {
  it("splits and skips already-translated cues", () => {
    const cues = [
      { data: { text: "a" } },
      { data: { text: "b", translatedText: "乙" } },
      { data: { text: "c" } },
    ];
    const chunks = splitIntoChunk(cues, 2);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].map((c: any) => c.data.text)).toEqual(["a", "c"]);
  });
});

describe("saveTranslated round-trip", () => {
  it("writes translations for srt and keeps original for __FAILED__", () => {
    const parsed = parseSubtitle(SRT, "srt");
    const cues = normalizeCues(parsed);
    cues[0].data.translatedText = "哈囉";
    cues[1].data.translatedText = "__FAILED__";
    const out = tmpFile("out.srt");
    saveTranslated(out, parsed, "srt", "none");
    const written = fs.readFileSync(out, "utf8");
    expect(written).toContain("哈囉");
    expect(written).not.toContain("__FAILED__");
    expect(written).toContain("World"); // 失敗行寫回原文
  });

  it("writes translations for ass and keeps original for __FAILED__", () => {
    const parsed = parseSubtitle(ASS, "ass");
    const cues = normalizeCues(parsed);
    cues[0].data.translatedText = "哈囉";
    cues[1].data.translatedText = "__FAILED__";
    const out = tmpFile("out.ass");
    saveTranslated(out, parsed, "ass", "none");
    const written = fs.readFileSync(out, "utf8");
    expect(written).toContain("哈囉");
    expect(written).not.toContain("__FAILED__");
    expect(written).toContain("World");
  });

  it("multiLangSave translate+original combines both", () => {
    const parsed = parseSubtitle(SRT, "srt");
    normalizeCues(parsed)[0].data.translatedText = "哈囉";
    const out = tmpFile("out.srt");
    saveTranslated(out, parsed, "srt", "translate+original");
    const written = fs.readFileSync(out, "utf8");
    expect(written).toContain("哈囉\nHello");
  });

  it("round-trips vtt", () => {
    const VTT = `WEBVTT

00:00:01.000 --> 00:00:02.000
Hello

00:00:03.000 --> 00:00:04.000
World
`;
    const parsed = parseSubtitle(VTT, "vtt");
    normalizeCues(parsed)[0].data.translatedText = "哈囉";
    const out = tmpFile("out.vtt");
    saveTranslated(out, parsed, "vtt", "none");
    const written = fs.readFileSync(out, "utf8");
    expect(written).toContain("WEBVTT");
    expect(written).toContain("哈囉");
    expect(written).toContain("World");
  });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run tests/unit/subtitle.test.ts` → FAIL（模組不存在）

- [ ] **Step 3: 建立 subtitle.ts**

自 `translate.ts` **原樣搬移** `splitIntoChunk`（35–50 行）、`parseSubtitle`（260–282 行）、`saveTranslated`（284–375 行）與相關 import（`node:fs`、`subtitle`、`ass-parser`、`ass-stringify`），並新增：

```ts
export function normalizeCues(parsed: any): any[] {
  if (Array.isArray(parsed)) {
    return parsed.filter((line: any) => line.type === "cue");
  }
  if (parsed && parsed.events) {
    return parsed.events;
  }
  return parsed;
}
```

`translate.ts` 刪除搬走的函式與不再用的 import（`node:fs`、`subtitle`、`ass-parser`、`ass-stringify`），export 清單同步更新。

- [ ] **Step 4: 更新使用端**

- `pipeline.ts`：`splitIntoChunk`、`parseSubtitle`、`saveTranslated` 改自 `./subtitle` import；主解析（原「`Array.isArray(parsed)` … `parsed.events`」if/else）與 resume 解析兩處改為 `const subtitle = normalizeCues(parsed);` / `const existingCues = normalizeCues(existingParsed);`
- `index.ts`：`get-subtitle-preview` 的兩處形狀判斷同樣改用 `normalizeCues`，`parseSubtitle` 改自 `./utils/subtitle` import。
- `tests/unit/pipeline.characterization.test.ts`：mock 目標改為只 mock AI 函式（translate.ts 現在只剩 AI 函式，`importOriginal` 展開可移除，直接列出四個 `vi.fn()`）。

- [ ] **Step 4.5: parseNumberedList 測試（translate.ts 補 export）**

`parseNumberedList` 留在 translate.ts（屬 AI 回應解析），但目前未 export——在 translate.ts 的 export 清單加入 `parseNumberedList`，並新增測試：

```ts
// tests/unit/parseNumberedList.test.ts
import { describe, it, expect } from "vitest";
import { parseNumberedList } from "../../electron/main/utils/translate";

describe("parseNumberedList", () => {
  it("parses a well-formed numbered list", () => {
    expect(parseNumberedList("1. 甲\n2. 乙\n3. 丙", 3)).toEqual(["甲", "乙", "丙"]);
  });
  it("returns null on count mismatch", () => {
    expect(parseNumberedList("1. 甲\n2. 乙", 3)).toBeNull();
  });
  it("ignores surrounding prose lines", () => {
    expect(parseNumberedList("Here you go:\n1. 甲\n2. 乙\nDone!", 2)).toEqual(["甲", "乙"]);
  });
});
```

Run: `npx vitest run tests/unit/parseNumberedList.test.ts` → PASS

- [ ] **Step 5: 驗證**

Run: `npx vitest run` → 全 PASS（特徵測試仍綠 = 行為未變）；`npx tsc` → 無錯誤

- [ ] **Step 6: Commit**

```bash
git add electron/main/utils/subtitle.ts electron/main/utils/translate.ts electron/main/utils/pipeline.ts electron/main/index.ts tests/unit/subtitle.test.ts tests/unit/parseNumberedList.test.ts tests/unit/pipeline.characterization.test.ts
git commit -m "refactor: extract subtitle parsing/saving into subtitle.ts with normalizeCues"
```

---

### Task 4: analysis.ts 拆分 + getOrCreateAnalysis

把 pipeline.ts 裡「讀快取 → 分段平行分析 → 合併 → 綜合 → 寫快取」的整段流程（原 index.ts:339-413 搬來的部分）收攏成 `getOrCreateAnalysis` 單一入口。

**Files:**
- Create: `electron/main/utils/analysis.ts`
- Create: `tests/unit/analysis.test.ts`
- Modify: `electron/main/utils/pipeline.ts`（分析流程改為一次呼叫；移出 hashContent 等）
- Modify: `electron/main/index.ts`（`check-analysis-cache` 改用 analysis.ts）

**Interfaces:**
- Consumes: `analyzeSubtitlesForContext`、`synthesizePlotSummaries`（translate.ts）
- Produces:

```ts
// analysis.ts exports
export function hashContent(content: string): string;
export function mergeGlossaries(
  glossaries: Array<Array<{ term: string; translation: string }>>
): Array<{ term: string; translation: string }>;
export function formatAnalysisContext(analysis: AnalysisResult): string;
export function analysisCachePath(filePath: string): string; // <file>.analysis.json
export function readAnalysisCache(
  cacheFile: string,
  contentHash: string
): AnalysisResult | null;
export async function getOrCreateAnalysis(opts: {
  texts: string[];
  cacheFile: string;
  contentHash: string;
  forceReanalyze: boolean;
  params: { apiKeys: string[]; apiHost: string; model: string; lang: string };
}): Promise<AnalysisResult | null>; // null = 分析全部失敗，翻譯照常進行
```

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/unit/analysis.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../electron/main/utils/translate", () => ({
  analyzeSubtitlesForContext: vi.fn(),
  synthesizePlotSummaries: vi.fn(),
  translateSubtitleChunk: vi.fn(),
  translateSubtitleSingle: vi.fn(),
}));

import {
  mergeGlossaries,
  formatAnalysisContext,
  readAnalysisCache,
  getOrCreateAnalysis,
  hashContent,
  analysisCachePath,
} from "../../electron/main/utils/analysis";
import * as translate from "../../electron/main/utils/translate";

const PARAMS = { apiKeys: ["k"], apiHost: "h", model: "m", lang: "zh-TW" };

function tmpCacheFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stx-")), "a.analysis.json");
}

beforeEach(() => {
  vi.mocked(translate.analyzeSubtitlesForContext).mockReset().mockResolvedValue({
    plotSummary: "part",
    glossary: [{ term: "Neo", translation: "尼歐" }],
  } as any);
  vi.mocked(translate.synthesizePlotSummaries).mockReset().mockResolvedValue("synth");
});

describe("mergeGlossaries", () => {
  it("dedupes case-insensitively, first wins", () => {
    const merged = mergeGlossaries([
      [{ term: "Neo", translation: "尼歐" }],
      [{ term: "neo", translation: "紐" }, { term: "Trinity", translation: "崔妮蒂" }],
    ]);
    expect(merged).toEqual([
      { term: "Neo", translation: "尼歐" },
      { term: "Trinity", translation: "崔妮蒂" },
    ]);
  });
});

describe("formatAnalysisContext", () => {
  it("omits glossary section when empty", () => {
    const s = formatAnalysisContext({ plotSummary: "p", glossary: [] } as any);
    expect(s).toContain("## Plot Summary");
    expect(s).not.toContain("## Glossary");
  });
});

describe("analysisCachePath", () => {
  it("replaces extension with .analysis.json", () => {
    expect(analysisCachePath("/a/b/movie.srt")).toBe("/a/b/movie.analysis.json");
  });
});

describe("getOrCreateAnalysis", () => {
  it("returns cached result without calling the model", async () => {
    const cacheFile = tmpCacheFile();
    const hash = hashContent("content");
    fs.writeFileSync(cacheFile, JSON.stringify({
      contentHash: hash,
      analysis: { plotSummary: "cached", glossary: [] },
    }));
    const r = await getOrCreateAnalysis({
      texts: ["a", "b", "c"], cacheFile, contentHash: hash,
      forceReanalyze: false, params: PARAMS,
    });
    expect(r!.plotSummary).toBe("cached");
    expect(translate.analyzeSubtitlesForContext).not.toHaveBeenCalled();
  });

  it("forceReanalyze bypasses cache and rewrites it", async () => {
    const cacheFile = tmpCacheFile();
    const hash = hashContent("content");
    fs.writeFileSync(cacheFile, JSON.stringify({
      contentHash: hash,
      analysis: { plotSummary: "cached", glossary: [] },
    }));
    const r = await getOrCreateAnalysis({
      texts: ["a", "b", "c"], cacheFile, contentHash: hash,
      forceReanalyze: true, params: PARAMS,
    });
    expect(r!.plotSummary).toBe("synth"); // 3 段 → synthesize
    const rewritten = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    expect(rewritten.analysis.plotSummary).toBe("synth");
  });

  it("returns null when every section fails", async () => {
    vi.mocked(translate.analyzeSubtitlesForContext).mockRejectedValue(new Error("x"));
    const r = await getOrCreateAnalysis({
      texts: ["a", "b", "c"], cacheFile: tmpCacheFile(), contentHash: "h",
      forceReanalyze: false, params: PARAMS,
    });
    expect(r).toBeNull();
  });

  it("tolerates corrupted cache file", async () => {
    const cacheFile = tmpCacheFile();
    fs.writeFileSync(cacheFile, "{not json");
    const r = await getOrCreateAnalysis({
      texts: ["a"], cacheFile, contentHash: "h",
      forceReanalyze: false, params: PARAMS,
    });
    expect(r!.plotSummary).toBe("part"); // 1 段 → 不經 synthesize
  });
});
```

- [ ] **Step 2: 執行確認失敗** → `npx vitest run tests/unit/analysis.test.ts` FAIL

- [ ] **Step 3: 建立 analysis.ts**

自 pipeline.ts **原樣搬移** `hashContent`、`ANALYSIS_SECTIONS`、`mergeGlossaries`、`formatAnalysisContext`，新增 `analysisCachePath`、`readAnalysisCache`、`getOrCreateAnalysis`——後者的本體就是 pipeline.ts 中現有的分析流程（try 區塊內：快取檢查 → sections 切分 → `Promise.all` 分段分析 → `mergeGlossaries` → `synthesizePlotSummaries`（含 `[Act N]` fallback）→ 寫快取），邏輯不變、只換簽名：

```ts
export function analysisCachePath(filePath: string): string {
  return filePath.replace(/\.[^/.]+$/, "") + ".analysis.json";
}

export function readAnalysisCache(
  cacheFile: string,
  contentHash: string
): AnalysisResult | null {
  if (!fs.existsSync(cacheFile)) return null;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (
      cached.contentHash === contentHash &&
      cached.analysis &&
      typeof cached.analysis === "object"
    ) {
      return cached.analysis as AnalysisResult;
    }
  } catch {}
  return null;
}

export async function getOrCreateAnalysis(opts: {
  texts: string[];
  cacheFile: string;
  contentHash: string;
  forceReanalyze: boolean;
  params: { apiKeys: string[]; apiHost: string; model: string; lang: string };
}): Promise<AnalysisResult | null> {
  const { texts, cacheFile, contentHash, forceReanalyze, params } = opts;

  if (!forceReanalyze) {
    const cached = readAnalysisCache(cacheFile, contentHash);
    if (cached) return cached;
  }

  const sectionSize = Math.ceil(texts.length / ANALYSIS_SECTIONS);
  const sections = Array.from({ length: ANALYSIS_SECTIONS }, (_, i) =>
    texts.slice(i * sectionSize, (i + 1) * sectionSize)
  ).filter((s) => s.length > 0);

  const sectionResults = await Promise.all(
    sections.map((section) =>
      analyzeSubtitlesForContext(section, {
        apiKeys: params.apiKeys,
        apiHost: params.apiHost,
        model: params.model,
        lang: params.lang,
        temperature: 0.3,
      }).catch(() => null)
    )
  );
  const validResults = sectionResults.filter((r): r is AnalysisResult => r !== null);
  if (validResults.length === 0) return null;

  const mergedGlossary = mergeGlossaries(validResults.map((r) => r.glossary));
  const summaries = validResults.map((r) => r.plotSummary);

  let plotSummary: string;
  if (summaries.length === 1) {
    plotSummary = summaries[0];
  } else {
    try {
      plotSummary = await synthesizePlotSummaries(summaries, {
        apiKeys: params.apiKeys,
        apiHost: params.apiHost,
        model: params.model,
        lang: params.lang,
        temperature: 0.3,
      });
    } catch {
      plotSummary = summaries.map((s, i) => `[Act ${i + 1}]\n${s}`).join("\n\n");
    }
  }

  const analysis: AnalysisResult = { plotSummary, glossary: mergedGlossary };
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ contentHash, analysis }), "utf8");
  } catch {}
  return analysis;
}
```

- [ ] **Step 4: 更新使用端**

- `pipeline.ts`：刪除搬走的函式，分析段改為：

```ts
const cacheFile = analysisCachePath(file.path);
let analysisData: AnalysisResult | null = null;
try {
  analysisData = await getOrCreateAnalysis({
    texts: allTexts,
    cacheFile,
    contentHash: fileHash,
    forceReanalyze: !!params.forceReanalyze,
    params: {
      apiKeys: params.apiKeys || [],
      apiHost: params.apiHost || "https://api.openai.com/v1",
      model: params.model || "",
      lang: params.lang || "",
    },
  });
  if (analysisData) {
    combinedAdditional = `${combinedAdditional ? combinedAdditional + "\n\n" : ""}${formatAnalysisContext(analysisData)}`;
    onProgress({ filePath: file.path, progress: 4, status: "analyzing", totalCues, currentCue: 0, analysis: analysisData });
  }
} catch (analysisErr) {
  console.warn("Context analysis failed, continue without it:", analysisErr);
}
```

- `index.ts`：`check-analysis-cache` 改用 `readAnalysisCache` + `analysisCachePath` + `hashContent`（皆 import 自 `./utils/analysis`）：

```ts
ipcMain.handle("check-analysis-cache", async (_, filePaths: string[]) => {
  const cached: string[] = [];
  for (const filePath of filePaths) {
    try {
      const fileContent = fs.readFileSync(filePath, "utf8");
      if (readAnalysisCache(analysisCachePath(filePath), hashContent(fileContent))) {
        cached.push(filePath);
      }
    } catch {}
  }
  return cached;
});
```

- [ ] **Step 5: 驗證** → `npx vitest run` 全 PASS（特徵測試仍綠）；`npx tsc` 無錯誤

- [ ] **Step 6: Commit**

```bash
git add electron/main/utils/analysis.ts electron/main/utils/pipeline.ts electron/main/index.ts tests/unit/analysis.test.ts
git commit -m "refactor: extract analysis orchestration into analysis.ts with getOrCreateAnalysis"
```

---

### Task 5: 行為修正（fallback 錯誤隔離、.ssa typo）+ 文件

三個獨立 commit：兩個行為修正、一個文件更新。

**Files:**
- Modify: `electron/main/utils/pipeline.ts`（最終 fallback 迴圈）
- Modify: `src/components/TranslatorPanel.tsx:350,392`（`.saa` → `.ssa`）
- Modify: `CLAUDE.md`（架構描述更新）
- Modify: `package.json`（version 1.9.1 → 1.9.2）
- Test: `tests/unit/pipeline.characterization.test.ts`（新增案例）

- [ ] **Step 1: 寫失敗測試（fallback 錯誤隔離）**

加入 `tests/unit/pipeline.characterization.test.ts`：

```ts
it("marks a line as failed instead of failing the whole file", async () => {
  vi.mocked(translate.translateSubtitleChunk).mockRejectedValue(new Error("boom"));
  vi.mocked(translate.translateSubtitleSingle).mockImplementation(async (s: string) => {
    if (s === "World") throw new Error("bad line");
    return `T:${s}`;
  });
  const file = makeTmpSrt();
  const events: any[] = [];
  await translateFile({ path: file, name: "movie.srt" }, BASE_PARAMS, (e) =>
    events.push(e)
  );
  const last = events[events.length - 1];
  expect(last.status).toBe("done"); // 不是 error
  expect(last.failedCues).toBe(1);
  expect(last.failedKeys).toHaveLength(1);
  const out = fs.readFileSync(file.replace(/\.srt$/, ".translated.srt"), "utf8");
  expect(out).toContain("T:Hello");
  expect(out).toContain("World"); // 失敗行保留原文
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run tests/unit/pipeline.characterization.test.ts` → 新案例 FAIL（目前整檔變 error）

- [ ] **Step 3: 實作修正**

pipeline.ts 最終 untranslated 迴圈中，`cue.data.translatedText = await retryTranslate(...)` 包上 try/catch：

```ts
try {
  cue.data.translatedText = await retryTranslate(
    async (singleText) =>
      translateSubtitleSingle(singleText, {
        /* 參數原樣保留 */
      }),
    cue.data.text
  );
} catch (lineErr) {
  console.warn("Line-level fallback failed, marking as __FAILED__:", lineErr);
  cue.data.translatedText = "__FAILED__";
  failedKeys.add(makeKey(cue.data.start, cue.data.end));
}
```

catch 之後的進度回報與部分寫檔邏輯照舊執行（失敗行也要計入 completedCues 前進進度）。

- [ ] **Step 4: 驗證 + Commit（行為修正 1）**

Run: `npx vitest run` → 全 PASS

```bash
git add electron/main/utils/pipeline.ts tests/unit/pipeline.characterization.test.ts
git commit -m "fix: isolate line-level fallback errors instead of failing whole file"
```

- [ ] **Step 5: 修 .ssa typo + Commit（行為修正 2）**

`TranslatorPanel.tsx` 兩處：drop filter 陣列 `[".ass", ".srt", ".vtt", ".saa"]` → `[".ass", ".srt", ".vtt", ".ssa"]`；`accept=".ass,.srt,.vtt,.saa"` → `accept=".ass,.srt,.vtt,.ssa"`。

Run: `npx tsc` → 無錯誤

```bash
git add src/components/TranslatorPanel.tsx
git commit -m "fix: accept .ssa extension (was misspelled .saa)"
```

- [ ] **Step 6: 更新 CLAUDE.md + 版本 + Commit（文件）**

CLAUDE.md 修改：
1. 「`utils/translate.ts` — All translation logic…」改為描述四模組分工：`translate.ts`（AI 呼叫）、`subtitle.ts`（解析/序列化）、`analysis.ts`（分析協調與快取）、`pipeline.ts`（翻譯流程協調）、`electron/shared/subtitleKey.ts`（跨程序共用）。
2. 刪除「`src/hooks/useOpenAI.ts` — renderer-side AI client…mirrors main-process logic」句，改為「`src/hooks/useOpenAI.ts` — localStorage-backed settings hooks (API keys, host, provider, temperature)」。
3. Commands 段補充 `npm test`（vitest 單元測試，測試檔在 `tests/unit/`）。

`package.json` version：`1.9.1` → `1.9.2`。

```bash
git add CLAUDE.md package.json
git commit -m "docs: update architecture notes for main-process refactor, bump to 1.9.2"
```

---

## Phase 2：劇集模式

### Task 6: 分析 schema 加 category + 每段上限 15 + existingGlossary 注入

**Files:**
- Modify: `electron/main/utils/translate.ts`（schema、prompt、`analyzeSubtitlesForContext` 簽名）
- Modify: `electron/main/utils/analysis.ts`（`readAnalysisCache` 舊快取正規化；`getOrCreateAnalysis` 傳遞 existingGlossary）
- Modify: `src/components/TranslatorPanel.tsx`（ProgressType.analysis.glossary 型別加 `category?: string`）
- Test: `tests/unit/analyze.test.ts`（新）、`tests/unit/analysis.test.ts`（補案例）

**Interfaces:**
- Produces:

```ts
// translate.ts
export type GlossaryCategory = "person" | "place" | "organization" | "term";
export interface GlossaryEntry {
  term: string;
  translation: string;
  category: GlossaryCategory;
}
// AnalysisResult.glossary 變為 GlossaryEntry[]
analyzeSubtitlesForContext(subtitles: string[], opts: {
  apiKeys: string[]; apiHost: string; model: string; lang: string;
  temperature?: number;
  existingGlossary?: GlossaryEntry[];   // 新增
}): Promise<AnalysisResult>
// analysis.ts getOrCreateAnalysis 的 opts 增加 existingGlossary?: GlossaryEntry[]
```

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/unit/analyze.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const generateObjectMock = vi.fn();
vi.mock("ai", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    generateObject: (...args: any[]) => generateObjectMock(...args),
  };
});

import { analyzeSubtitlesForContext } from "../../electron/main/utils/translate";

const OPTS = { apiKeys: ["k"], apiHost: "https://h/v1", model: "m", lang: "zh-TW" };

beforeEach(() => {
  generateObjectMock.mockReset().mockResolvedValue({
    object: { plotSummary: "p", glossary: [] },
  });
});

describe("analyzeSubtitlesForContext", () => {
  it("schema accepts only the four glossary categories", async () => {
    await analyzeSubtitlesForContext(["line"], OPTS);
    const { schema } = generateObjectMock.mock.calls[0][0];
    expect(() =>
      schema.parse({
        plotSummary: "p",
        glossary: [{ term: "Neo", translation: "尼歐", category: "person" }],
      })
    ).not.toThrow();
    expect(() =>
      schema.parse({
        plotSummary: "p",
        glossary: [{ term: "run", translation: "跑", category: "verb" }],
      })
    ).toThrow();
    expect(() =>
      schema.parse({
        plotSummary: "p",
        glossary: [{ term: "Neo", translation: "尼歐" }], // 缺 category
      })
    ).toThrow();
  });

  it("prompt limits glossary to 15 proper-noun entries", async () => {
    await analyzeSubtitlesForContext(["line"], OPTS);
    const { system } = generateObjectMock.mock.calls[0][0];
    expect(system).toContain("Up to 15");
    expect(system).toMatch(/proper nouns/i);
  });

  it("injects existing glossary as mandatory translations", async () => {
    await analyzeSubtitlesForContext(["line"], {
      ...OPTS,
      existingGlossary: [{ term: "Neo", translation: "尼歐", category: "person" }],
    });
    const { system } = generateObjectMock.mock.calls[0][0];
    expect(system).toContain("Neo: 尼歐");
    expect(system).toMatch(/MUST reuse/i);
  });

  it("omits the established-glossary section when none exists", async () => {
    await analyzeSubtitlesForContext(["line"], OPTS);
    const { system } = generateObjectMock.mock.calls[0][0];
    expect(system).not.toMatch(/MUST reuse/i);
  });
});
```

- [ ] **Step 2: 執行確認失敗** → `npx vitest run tests/unit/analyze.test.ts` FAIL

- [ ] **Step 3: 實作 translate.ts 修改**

```ts
const glossaryCategorySchema = z.enum(["person", "place", "organization", "term"]);

const glossaryEntrySchema = z.object({
  term: z.string(),
  translation: z.string(),
  category: glossaryCategorySchema,
});

const analysisSchema = z.object({
  plotSummary: z.string(),
  glossary: z.array(glossaryEntrySchema),
});

export type GlossaryCategory = z.infer<typeof glossaryCategorySchema>;
export type GlossaryEntry = z.infer<typeof glossaryEntrySchema>;
```

`analyzeSubtitlesForContext` 增加 `existingGlossary` 參數，system prompt 改為：

```ts
const existingSection =
  existingGlossary && existingGlossary.length > 0
    ? `\n\nAn established glossary already exists for this series. You MUST reuse these exact translations whenever these terms appear. Do NOT repeat them in your glossary output:\n${existingGlossary
        .map((g) => `- ${g.term}: ${g.translation}`)
        .join("\n")}`
    : "";

// system:
`You are a subtitle content analyst for a translation system.
Analyze the provided subtitle sample and return:
1. plotSummary: A ${lang} narrative (5–10 sentences) describing what happens. Write naturally, not as a literal stitch of subtitles.
2. glossary: Up to 15 entries of proper nouns ONLY — person names (category "person"), place names ("place"), organization or group names ("organization"), and titles, fictional terms or domain-specific jargon ("term"). Do NOT include common nouns, everyday vocabulary, or full sentences. For each entry provide the term as it appears, its preferred ${lang} translation or rendering (repeat the original term if no translation exists), and its category.${existingSection}`
```

- [ ] **Step 4: 舊快取正規化（analysis.ts）+ 測試**

`readAnalysisCache` 回傳前正規化缺 category 的舊快取項目：

```ts
if (Array.isArray(cached.analysis.glossary)) {
  cached.analysis.glossary = cached.analysis.glossary.map((g: any) => ({
    ...g,
    category: g.category ?? "term",
  }));
}
```

`getOrCreateAnalysis` 的 opts 增加 `existingGlossary?: GlossaryEntry[]`，原樣傳給每段 `analyzeSubtitlesForContext`。

`tests/unit/analysis.test.ts` 補案例：

```ts
it("fills missing category as 'term' when reading legacy cache", () => {
  const cacheFile = tmpCacheFile();
  const hash = hashContent("c");
  fs.writeFileSync(cacheFile, JSON.stringify({
    contentHash: hash,
    analysis: { plotSummary: "p", glossary: [{ term: "Neo", translation: "尼歐" }] },
  }));
  const r = readAnalysisCache(cacheFile, hash);
  expect(r!.glossary[0].category).toBe("term");
});

it("passes existingGlossary through to every section analysis", async () => {
  const existing = [{ term: "Neo", translation: "尼歐", category: "person" as const }];
  await getOrCreateAnalysis({
    texts: ["a", "b", "c"], cacheFile: tmpCacheFile(), contentHash: "h",
    forceReanalyze: false, params: PARAMS, existingGlossary: existing,
  });
  for (const call of vi.mocked(translate.analyzeSubtitlesForContext).mock.calls) {
    expect(call[1].existingGlossary).toEqual(existing);
  }
});
```

- [ ] **Step 5: 修既有測試 mock 與 renderer 型別**

- 既有測試中所有 glossary mock 物件補上 `category`（如 `{ term: "Hello", translation: "哈囉", category: "term" }`）。
- `TranslatorPanel.tsx` 的 `ProgressType.analysis.glossary` 型別改為 `Array<{ term: string; translation: string; category?: string }>`（顯示不變）。

- [ ] **Step 6: 驗證** → `npx vitest run` 全 PASS；`npx tsc` 無錯誤

- [ ] **Step 7: Commit**

```bash
git add electron/main/utils/translate.ts electron/main/utils/analysis.ts src/components/TranslatorPanel.tsx tests/unit/analyze.test.ts tests/unit/analysis.test.ts tests/unit/pipeline.characterization.test.ts
git commit -m "feat(analyze): structured glossary categories, 15-entry section cap, existing-glossary injection"
```

---

### Task 7: seriesGlossary.ts — 載入 / 合併（准入 + 上限）/ 儲存

**Files:**
- Create: `electron/main/utils/seriesGlossary.ts`
- Create: `tests/unit/seriesGlossary.test.ts`

**Interfaces:**
- Consumes: `GlossaryEntry`（Task 6）
- Produces:

```ts
export const SERIES_GLOSSARY_FILE = ".series-glossary.json";
export const SERIES_GLOSSARY_CAP = 100;
export function loadSeriesGlossary(folder: string): GlossaryEntry[]; // 損毀/不存在 → []
export function mergeIntoSeriesGlossary(
  existing: GlossaryEntry[],
  incoming: GlossaryEntry[]
): GlossaryEntry[]; // 先到者勝 + 准入過濾 + 100 條裁剪
export function saveSeriesGlossary(folder: string, terms: GlossaryEntry[]): void;
```

- [ ] **Step 1: 寫失敗測試**

```ts
// tests/unit/seriesGlossary.test.ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSeriesGlossary,
  mergeIntoSeriesGlossary,
  saveSeriesGlossary,
  SERIES_GLOSSARY_FILE,
  SERIES_GLOSSARY_CAP,
} from "../../electron/main/utils/seriesGlossary";

const e = (term: string, category: any = "term") => ({
  term,
  translation: `譯${term}`,
  category,
});

function tmpFolder(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stx-"));
}

describe("mergeIntoSeriesGlossary", () => {
  it("first wins, case-insensitive", () => {
    const merged = mergeIntoSeriesGlossary([e("Neo")], [e("neo"), e("Trinity")]);
    expect(merged.map((x) => x.term)).toEqual(["Neo", "Trinity"]);
  });

  it("rejects entries with invalid category", () => {
    const merged = mergeIntoSeriesGlossary([], [e("Neo", "person"), e("run", "verb")]);
    expect(merged.map((x) => x.term)).toEqual(["Neo"]);
  });

  it("caps at 100 with category priority person > organization > place > term", () => {
    const terms = [
      ...Array.from({ length: 40 }, (_, i) => e(`term${i}`, "term")),
      ...Array.from({ length: 30 }, (_, i) => e(`place${i}`, "place")),
      ...Array.from({ length: 20 }, (_, i) => e(`org${i}`, "organization")),
      ...Array.from({ length: 20 }, (_, i) => e(`person${i}`, "person")),
    ]; // 110 條
    const merged = mergeIntoSeriesGlossary([], terms);
    expect(merged).toHaveLength(SERIES_GLOSSARY_CAP);
    // 全部 person/organization/place（70 條）存活，term 被裁至 30 條
    expect(merged.filter((x) => x.category === "person")).toHaveLength(20);
    expect(merged.filter((x) => x.category === "organization")).toHaveLength(20);
    expect(merged.filter((x) => x.category === "place")).toHaveLength(30);
    expect(merged.filter((x) => x.category === "term")).toHaveLength(30);
    // term 之中先到者存活
    expect(merged.some((x) => x.term === "term0")).toBe(true);
    expect(merged.some((x) => x.term === "term39")).toBe(false);
  });
});

describe("load/save", () => {
  it("round-trips through the folder file", () => {
    const folder = tmpFolder();
    saveSeriesGlossary(folder, [e("Neo", "person")]);
    expect(fs.existsSync(path.join(folder, SERIES_GLOSSARY_FILE))).toBe(true);
    expect(loadSeriesGlossary(folder)).toEqual([e("Neo", "person")]);
  });

  it("returns [] for missing or corrupted file", () => {
    const folder = tmpFolder();
    expect(loadSeriesGlossary(folder)).toEqual([]);
    fs.writeFileSync(path.join(folder, SERIES_GLOSSARY_FILE), "{oops");
    expect(loadSeriesGlossary(folder)).toEqual([]);
  });

  it("fills missing category as 'term' when loading legacy entries", () => {
    const folder = tmpFolder();
    fs.writeFileSync(
      path.join(folder, SERIES_GLOSSARY_FILE),
      JSON.stringify({ terms: [{ term: "Neo", translation: "尼歐" }] })
    );
    expect(loadSeriesGlossary(folder)[0].category).toBe("term");
  });
});
```

- [ ] **Step 2: 執行確認失敗** → FAIL（模組不存在）

- [ ] **Step 3: 實作**

```ts
// electron/main/utils/seriesGlossary.ts
import fs from "node:fs";
import path from "node:path";
import type { GlossaryEntry } from "./translate";

export const SERIES_GLOSSARY_FILE = ".series-glossary.json";
export const SERIES_GLOSSARY_CAP = 100;

const CATEGORY_PRIORITY: Record<string, number> = {
  person: 0,
  organization: 1,
  place: 2,
  term: 3,
};

export function loadSeriesGlossary(folder: string): GlossaryEntry[] {
  const file = path.join(folder, SERIES_GLOSSARY_FILE);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed.terms)) return [];
    return parsed.terms
      .filter((t: any) => t && typeof t.term === "string" && typeof t.translation === "string")
      .map((t: any) => ({ ...t, category: t.category ?? "term" }));
  } catch {
    return [];
  }
}

export function mergeIntoSeriesGlossary(
  existing: GlossaryEntry[],
  incoming: GlossaryEntry[]
): GlossaryEntry[] {
  const seen = new Set<string>();
  const merged: GlossaryEntry[] = [];
  for (const entry of [...existing, ...incoming]) {
    if (!(entry.category in CATEGORY_PRIORITY)) continue; // 准入過濾
    const key = entry.term.toLowerCase();
    if (seen.has(key)) continue; // 先到者勝
    seen.add(key);
    merged.push(entry);
  }
  if (merged.length <= SERIES_GLOSSARY_CAP) return merged;
  return merged
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        CATEGORY_PRIORITY[a.entry.category] - CATEGORY_PRIORITY[b.entry.category] ||
        a.index - b.index
    )
    .slice(0, SERIES_GLOSSARY_CAP)
    .map(({ entry }) => entry);
}

export function saveSeriesGlossary(folder: string, terms: GlossaryEntry[]): void {
  try {
    fs.writeFileSync(
      path.join(folder, SERIES_GLOSSARY_FILE),
      JSON.stringify({ terms }, null, 2),
      "utf8"
    );
  } catch {
    // 寫入失敗不阻斷翻譯（例如唯讀資料夾）
  }
}
```

（注意：裁剪後條目會依 category 重新分組排序，這是規格允許的——同 category 內先到者順序保留。）

- [ ] **Step 4: 驗證** → `npx vitest run tests/unit/seriesGlossary.test.ts` PASS

- [ ] **Step 5: Commit**

```bash
git add electron/main/utils/seriesGlossary.ts tests/unit/seriesGlossary.test.ts
git commit -m "feat(series): series glossary storage with admission filter and capped merge"
```

---

### Task 8: 劇集模式整合 — 資料夾分組循序 + 詞彙表注入回寫

**Files:**
- Modify: `electron/main/utils/pipeline.ts`（分析段接上 series glossary；新增 `groupFilesByFolder`）
- Modify: `electron/main/index.ts`（batch-translate 改為「資料夾組間並行、組內循序」）
- Modify: `CLAUDE.md`、`package.json`（version 1.10.0）
- Test: `tests/unit/pipeline.series.test.ts`（新）、`tests/unit/groupFiles.test.ts`（新）

**Interfaces:**
- Consumes: `loadSeriesGlossary` / `mergeIntoSeriesGlossary` / `saveSeriesGlossary`（Task 7）、`getOrCreateAnalysis` 的 `existingGlossary`（Task 6）
- Produces: `groupFilesByFolder(files: Array<{path: string; name: string}>): Array<Array<{path: string; name: string}>>`

- [ ] **Step 1: 寫失敗測試（分組排序）**

```ts
// tests/unit/groupFiles.test.ts
import { describe, it, expect } from "vitest";
import { groupFilesByFolder } from "../../electron/main/utils/pipeline";

describe("groupFilesByFolder", () => {
  it("groups by dirname and natural-sorts within group", () => {
    const groups = groupFilesByFolder([
      { path: "/show-a/EP10.srt", name: "EP10.srt" },
      { path: "/show-b/01.srt", name: "01.srt" },
      { path: "/show-a/EP2.srt", name: "EP2.srt" },
      { path: "/show-a/EP1.srt", name: "EP1.srt" },
    ]);
    expect(groups).toHaveLength(2);
    const showA = groups.find((g) => g[0].path.startsWith("/show-a"))!;
    expect(showA.map((f) => f.name)).toEqual(["EP1.srt", "EP2.srt", "EP10.srt"]);
  });
});
```

- [ ] **Step 2: 寫失敗測試（詞彙表注入與回寫）**

```ts
// tests/unit/pipeline.series.test.ts
// mock 佈置與 tests/unit/pipeline.characterization.test.ts 相同
// （vi.mock translate 四函式 + resetMocks，glossary mock 需含 category），
// 差異：analyzeSubtitlesForContext 依輸入回傳不同 glossary。
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../electron/main/utils/translate", () => ({
  translateSubtitleChunk: vi.fn(),
  translateSubtitleSingle: vi.fn(),
  analyzeSubtitlesForContext: vi.fn(),
  synthesizePlotSummaries: vi.fn(),
}));

import { translateFile } from "../../electron/main/utils/pipeline";
import { loadSeriesGlossary, SERIES_GLOSSARY_FILE } from "../../electron/main/utils/seriesGlossary";
import * as translate from "../../electron/main/utils/translate";

const SRT_EP = (line: string) => `1
00:00:01,000 --> 00:00:02,000
${line}
`;

const BASE_PARAMS = {
  apiKeys: ["k"], apiHost: "https://h/v1", model: "m",
  prompt: "p {{lang}} {{additional}}", lang: "zh-TW", additional: "", temperature: 1,
};

beforeEach(() => {
  vi.mocked(translate.translateSubtitleChunk).mockReset()
    .mockImplementation(async (subs: string[]) => subs.map((s) => `T:${s}`));
  vi.mocked(translate.translateSubtitleSingle).mockReset()
    .mockImplementation(async (s: string) => `T:${s}`);
  vi.mocked(translate.synthesizePlotSummaries).mockReset().mockResolvedValue("synth");
});

it("episode 2 analysis receives episode 1 glossary; series file accumulates", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "stx-series-"));
  const ep1 = path.join(folder, "EP1.srt");
  const ep2 = path.join(folder, "EP2.srt");
  fs.writeFileSync(ep1, SRT_EP("Neo appears"), "utf8");
  fs.writeFileSync(ep2, SRT_EP("Trinity appears"), "utf8");

  vi.mocked(translate.analyzeSubtitlesForContext).mockReset()
    .mockImplementation(async (subs: string[]) => ({
      plotSummary: "p",
      glossary: subs.join(" ").includes("Neo")
        ? [{ term: "Neo", translation: "尼歐", category: "person" as const }]
        : [{ term: "Trinity", translation: "崔妮蒂", category: "person" as const }],
    }));

  await translateFile({ path: ep1, name: "EP1.srt" }, BASE_PARAMS, () => {});

  // EP1 後：series glossary 已含 Neo
  expect(loadSeriesGlossary(folder).map((t) => t.term)).toEqual(["Neo"]);

  await translateFile({ path: ep2, name: "EP2.srt" }, BASE_PARAMS, () => {});

  // EP2 的分析收到了 EP1 的詞彙
  const ep2Calls = vi.mocked(translate.analyzeSubtitlesForContext).mock.calls
    .filter(([subs]) => subs.join(" ").includes("Trinity"));
  expect(ep2Calls.length).toBeGreaterThan(0);
  for (const call of ep2Calls) {
    expect(call[1].existingGlossary!.map((g: any) => g.term)).toContain("Neo");
  }

  // series glossary 累積兩集詞彙
  const terms = loadSeriesGlossary(folder).map((t) => t.term).sort();
  expect(terms).toEqual(["Neo", "Trinity"]);
});
```

- [ ] **Step 3: 執行確認失敗** → 兩個新測試 FAIL

- [ ] **Step 4: 實作 pipeline.ts**

新增 `groupFilesByFolder`：

```ts
export function groupFilesByFolder(
  files: Array<{ path: string; name: string }>
): Array<Array<{ path: string; name: string }>> {
  const groups = new Map<string, Array<{ path: string; name: string }>>();
  for (const f of files) {
    const dir = path.dirname(f.path);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(f);
  }
  for (const group of groups.values()) {
    group.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
    );
  }
  return [...groups.values()];
}
```

`translateFile` 分析段改為：

```ts
const folder = path.dirname(file.path);
const seriesTerms = loadSeriesGlossary(folder);

analysisData = await getOrCreateAnalysis({
  /* 原有參數不變 */
  existingGlossary: seriesTerms,
});

if (analysisData) {
  const combinedGlossary = mergeIntoSeriesGlossary(seriesTerms, analysisData.glossary);
  saveSeriesGlossary(folder, combinedGlossary);
  // [Context] 與進度事件都使用合併後的完整詞彙表
  analysisData = { plotSummary: analysisData.plotSummary, glossary: combinedGlossary };
  combinedAdditional = `${
    combinedAdditional ? combinedAdditional + "\n\n" : ""
  }${formatAnalysisContext(analysisData)}`;
  onProgress({
    filePath: file.path,
    progress: 4,
    status: "analyzing",
    totalCues,
    currentCue: 0,
    analysis: analysisData,
  });
}
```

- [ ] **Step 5: 實作 index.ts 分組循序**

```ts
import { translateFile, groupFilesByFolder } from "./utils/pipeline";

ipcMain.handle("batch-translate", async (event, { files, params }) => {
  const processFile = async (file) => { /* 不變 */ };
  const groups = groupFilesByFolder(files);
  for await (const _ of pool(3, groups, async (group) => {
    for (const file of group) {
      await processFile(file); // 同資料夾循序，確保後集吃到前集詞彙
    }
  })) {
    // 不同資料夾之間維持並行（concurrency 3）
  }
  return { success: true };
});
```

- [ ] **Step 6: 驗證** → `npx vitest run` 全 PASS（特徵測試仍綠：單一檔案情境行為不變，僅 analysis 事件的 glossary 可能經過合併——若特徵測試對 glossary 內容有斷言需確認仍成立）；`npx tsc` 無錯誤

- [ ] **Step 7: 更新 CLAUDE.md + 版本 + Commit**

CLAUDE.md 的 Translation Pipeline 段落加一點：

```
Series mode: subtitle files in the same folder share an accumulated glossary
(`.series-glossary.json`, first-wins, capped at 100 entries by category priority
person > organization > place > term). Files in the same folder are processed
sequentially (natural filename order); different folders run in parallel.
Delete the JSON file to reset the series glossary.
```

`package.json` version → `1.10.0`。

```bash
git add electron/main/utils/pipeline.ts electron/main/index.ts tests/unit/pipeline.series.test.ts tests/unit/groupFiles.test.ts CLAUDE.md package.json
git commit -m "feat(series): folder-scoped accumulated glossary with sequential per-folder processing"
```

---

## Phase 3：失敗行重試

### Task 9: retry-file IPC + 重試機制測試

**Files:**
- Modify: `electron/main/index.ts`（新增 `retry-file` handler）
- Test: `tests/unit/pipeline.retry.test.ts`（新）

**Interfaces:**
- Produces: IPC `retry-file`，payload `{ file: { path: string; name: string }, params: TranslateParams }`，進度沿用 `batch-progress` 事件，回傳 `{ success: true }`。

- [ ] **Step 1: 寫失敗測試（釘死 resume 重試機制）**

```ts
// tests/unit/pipeline.retry.test.ts
// mock 佈置同 pipeline.characterization.test.ts（含 category 的 glossary mock）
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../electron/main/utils/translate", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    translateSubtitleChunk: vi.fn(),
    translateSubtitleSingle: vi.fn(),
    analyzeSubtitlesForContext: vi.fn(),
    synthesizePlotSummaries: vi.fn(),
  };
});

import { translateFile } from "../../electron/main/utils/pipeline";
import * as translate from "../../electron/main/utils/translate";

const SRT = `1
00:00:01,000 --> 00:00:02,000
Hello

2
00:00:03,000 --> 00:00:04,000
World

3
00:00:05,000 --> 00:00:06,000
Again
`;

const BASE_PARAMS = {
  apiKeys: ["k"], apiHost: "https://h/v1", model: "m",
  prompt: "p {{lang}} {{additional}}", lang: "zh-TW", additional: "", temperature: 1,
};

beforeEach(() => {
  vi.mocked(translate.analyzeSubtitlesForContext).mockReset().mockResolvedValue({
    plotSummary: "p",
    glossary: [{ term: "Hello", translation: "哈囉", category: "term" }],
  } as any);
  vi.mocked(translate.synthesizePlotSummaries).mockReset().mockResolvedValue("synth");
});

it("second run retranslates only the previously failed line", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stx-retry-"));
  const file = path.join(dir, "movie.srt");
  fs.writeFileSync(file, SRT, "utf8");

  // 第一輪：World 失敗（chunk 整體失敗 → 逐行 fallback → World 連單行也失敗）
  vi.mocked(translate.translateSubtitleChunk).mockReset()
    .mockRejectedValue(new Error("boom"));
  vi.mocked(translate.translateSubtitleSingle).mockReset()
    .mockImplementation(async (s: string) => {
      if (s === "World") throw new Error("bad line");
      return `T:${s}`;
    });

  const firstEvents: any[] = [];
  await translateFile({ path: file, name: "movie.srt" }, BASE_PARAMS, (e) =>
    firstEvents.push(e)
  );
  expect(firstEvents[firstEvents.length - 1].failedCues).toBe(1);
  const outPath = file.replace(/\.srt$/, ".translated.srt");
  expect(fs.readFileSync(outPath, "utf8")).toContain("World"); // 失敗行=原文

  // 第二輪：全部恢復正常，重跑同一檔案
  vi.mocked(translate.translateSubtitleChunk).mockReset()
    .mockImplementation(async (subs: string[]) => subs.map((s) => `R:${s}`));
  vi.mocked(translate.translateSubtitleSingle).mockReset()
    .mockImplementation(async (s: string) => `R:${s}`);

  const secondEvents: any[] = [];
  await translateFile({ path: file, name: "movie.srt" }, BASE_PARAMS, (e) =>
    secondEvents.push(e)
  );

  const last = secondEvents[secondEvents.length - 1];
  expect(last.status).toBe("done");
  expect(last.failedCues).toBe(0);

  const out = fs.readFileSync(outPath, "utf8");
  expect(out).toContain("T:Hello"); // 第一輪成果保留，未被重譯
  expect(out).toContain("T:Again");
  expect(out).toContain("R:World"); // 只有失敗行用第二輪結果

  // 分析走快取，第二輪不再呼叫分析
  const analyzeCallsSecondRun =
    vi.mocked(translate.analyzeSubtitlesForContext).mock.calls.length;
  expect(analyzeCallsSecondRun).toBeLessThanOrEqual(3); // 僅第一輪的 3 段
});
```

- [ ] **Step 2: 執行測試**

Run: `npx vitest run tests/unit/pipeline.retry.test.ts`
Expected: PASS（此機制在 Task 5 修正後即已成立——本測試的價值是釘死它防回歸。若 FAIL，用 systematic-debugging 找出 resume/failed 標記的行為差異）

- [ ] **Step 3: 新增 retry-file handler（index.ts）**

```ts
ipcMain.handle("retry-file", async (event, { file, params }) => {
  await translateFile(file, params, (data) => {
    if (data.analysis) analysisCache.set(data.filePath, data.analysis);
    event.sender.send("batch-progress", data);
  });
  return { success: true };
});
```

- [ ] **Step 4: 驗證** → `npx vitest run` 全 PASS

- [ ] **Step 5: Commit**

```bash
git add electron/main/index.ts tests/unit/pipeline.retry.test.ts
git commit -m "feat(retry): add retry-file IPC reusing resume-based pipeline"
```

---

### Task 10: 重譯失敗行 UI + i18n + 版本

**Files:**
- Modify: `src/components/TranslatorPanel.tsx`
- Modify: `src/locales/en-US.json`、`src/locales/zh-TW.json`、`src/locales/zh-CN.json`
- Modify: `package.json`（version 1.11.0）

**Interfaces:**
- Consumes: IPC `retry-file`（Task 9）、既有 `batch-progress` 監聽（新事件自動更新 failedKeys/failedCues）。

- [ ] **Step 1: 抽出 buildParams 消除重複**

`TranslatorPanel.tsx` 中 `executeBatchTranslation` 的 params 物件抽成函式（重試需要同一組參數）：

```tsx
const buildParams = (forceReanalyze: boolean) => ({
  apiKeys: keys,
  apiHost,
  model,
  prompt,
  lang,
  additional,
  temperature,
  multiLangSave,
  delay: delay * 1000,
  forceReanalyze,
  concurrentRequests,
});
```

`executeBatchTranslation` 改用 `const params = buildParams(forceReanalyze);`。

- [ ] **Step 2: 新增重試函式與按鈕**

```tsx
const selectedProgress = selectedFile
  ? batchProgress[selectedFile.path]
  : undefined;
const canRetryFailed =
  !isTranslating &&
  selectedProgress?.status === "done" &&
  (selectedProgress.failedCues ?? 0) > 0 &&
  multiLangSave === "none";

const retryFailedLines = async () => {
  if (!selectedFile) return;
  setIsTranslating(true);
  try {
    await ipcRenderer.invoke("retry-file", {
      file: selectedFile,
      params: buildParams(false),
    });
    await loadCues(selectedFile.path);
  } catch (e: unknown) {
    toast.error(`Retry failed: ${(e as Error).message}`);
  }
  setIsTranslating(false);
};
```

Modal 標題列（`<h3>` 與關閉按鈕之間）插入：

```tsx
{canRetryFailed && (
  <Button
    onClick={retryFailedLines}
    icon="bx-refresh"
    variant="primary"
    className="shrink-0 mr-2"
  >
    {t("translate.retry_failed", {
      count: selectedProgress?.failedCues,
    })}
  </Button>
)}
```

- [ ] **Step 3: i18n 三語系**

三個語系檔的 `translation` → `translate` 物件內（`line_failed` 旁）各加一鍵：

- `zh-TW.json`: `"retry_failed": "重譯 {{count}} 行失敗字幕"`
- `zh-CN.json`: `"retry_failed": "重译 {{count}} 行失败字幕"`
- `en-US.json`: `"retry_failed": "Retry {{count}} failed lines"`

- [ ] **Step 4: 型別與 i18n 檢查**

Run: `npx tsc` → 無錯誤
執行 `/i18n-sync` 技能（或手動比對三檔 key）確認三語系 key 一致。

- [ ] **Step 5: 手動煙霧測試**

Run: `npm run dev`
操作：拖入一個字幕檔並以無效 API host 翻譯使其部分失敗 → 開 modal 應見「重譯 N 行失敗字幕」按鈕 → 改回正確設定後點擊 → 失敗行被重譯、橘色標記消失。
（若無法方便製造失敗，至少確認正常翻譯流程與 modal 顯示無 regression。）

- [ ] **Step 6: 版本 + Commit**

`package.json` version → `1.11.0`。

```bash
git add src/components/TranslatorPanel.tsx src/locales/en-US.json src/locales/zh-TW.json src/locales/zh-CN.json package.json
git commit -m "feat(ui): retry failed lines button in preview modal"
```

---

## 收尾驗證（每個 Phase 結束時）

- [ ] `npx vitest run` 全 PASS
- [ ] `npx tsc` 無錯誤
- [ ] `npm run pree2e` 建置成功（確認 electron/ 端無編譯錯誤、tests/ 未被打包）
- [ ] Phase 3 結束後：`npm run dev` 手動完整走一次「兩集同資料夾檔案翻譯 → 檢查 `.series-glossary.json` → 製造失敗 → 重譯失敗行」
