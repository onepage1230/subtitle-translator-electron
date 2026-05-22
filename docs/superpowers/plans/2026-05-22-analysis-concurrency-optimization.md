# Analysis & Concurrency Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut global analysis time from 10–20 min to ~2–4 min via parallel sectioned analysis with structured output, fix local-model throughput degradation via auto-detected concurrency, and correct the version update comparison bug.

**Architecture:** Three independent changes share one plan: (1) `translate.ts` gains structured `generateObject`-based analysis + a synthesis helper; (2) `index.ts` orchestrates 3 parallel analysis sections, merges results, and picks pool size from apiHost; (3) renderer gains a settings knob and a structured analysis display.

**Tech Stack:** Electron + TypeScript, Vercel AI SDK (`ai`, `@ai-sdk/openai-compatible`), `zod`, `tiny-async-pool`, React + `usehooks-ts`

---

## File Map

| File | Role |
|---|---|
| `src/layouts/default.tsx` | Fix `isNewerVersion` — no other changes |
| `electron/main/utils/translate.ts` | Add `AnalysisResult` type + `analysisSchema`; rewrite `analyzeSubtitlesForContext`; add `synthesizePlotSummaries`; remove dead `deduplicateLines` |
| `electron/main/index.ts` | Add `ANALYSIS_SECTIONS`, `mergeGlossaries`, `formatAnalysisContext`, `isLocalModel`; replace analysis block with parallel pipeline; apply concurrency detection to pool |
| `src/components/settings/ConcurrentRequests.tsx` | New component — mirrors `Delay.tsx` pattern |
| `src/pages/settings.tsx` | Import + render `<ConcurrentRequests />` |
| `src/components/TranslatorPanel.tsx` | Add `concurrentRequests` to IPC params; update `ProgressType.analysis` type; update modal display |
| `src/locales/en-US.json` | Add `concurrent_requests` i18n keys |
| `src/locales/zh-TW.json` | Add `concurrent_requests` i18n keys |
| `src/locales/zh-CN.json` | Add `concurrent_requests` i18n keys |

---

## Task 1: Fix version comparison bug

**Files:**
- Modify: `src/layouts/default.tsx`

- [ ] **Step 1: Verify the bug with a test script**

```bash
node -e "
const v = '1.9.0';
const remote = 'v1.8.0';
console.log('Bug present (both should be false):', v != remote, remote != v);
"
```
Expected output: `Bug present (both should be false): true true`

- [ ] **Step 2: Add `isNewerVersion` before the `CheckUpdate` function**

In `src/layouts/default.tsx`, add this function before `function CheckUpdate()` (around line 24):

```typescript
function isNewerVersion(remote: string, local: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [ra, rb, rc] = parse(remote);
  const [la, lb, lc] = parse(local);
  if (ra !== la) return ra > la;
  if (rb !== lb) return rb > lb;
  return rc > lc;
}
```

- [ ] **Step 3: Replace both version comparisons**

In `src/layouts/default.tsx`:

Line 37 — replace:
```typescript
if (version && newVersion && version != newVersion) {
```
with:
```typescript
if (version && newVersion && isNewerVersion(newVersion, version)) {
```

Line 51 — replace:
```typescript
if (version && newVersion && version != newVersion) {
```
with:
```typescript
if (version && newVersion && isNewerVersion(newVersion, version)) {
```

- [ ] **Step 4: Verify the fix**

```bash
node -e "
function isNewerVersion(remote, local) {
  const parse = (v) => v.replace(/^v/, '').split('.').map(Number);
  const [ra, rb, rc] = parse(remote);
  const [la, lb, lc] = parse(local);
  if (ra !== la) return ra > la;
  if (rb !== lb) return rb > lb;
  return rc > lc;
}
console.assert(isNewerVersion('v1.8.0', '1.9.0') === false, 'FAIL: older remote should return false');
console.assert(isNewerVersion('v2.0.0', '1.9.0') === true,  'FAIL: newer major should return true');
console.assert(isNewerVersion('v1.9.0', '1.9.0') === false, 'FAIL: same version should return false');
console.assert(isNewerVersion('v1.9.1', '1.9.0') === true,  'FAIL: newer patch should return true');
console.log('All assertions passed');
"
```
Expected: `All assertions passed`

- [ ] **Step 5: Commit**

```bash
git add src/layouts/default.tsx
git commit -m "fix(ui): correct version comparison to use semver ordering"
```

---

## Task 2: Rewrite `analyzeSubtitlesForContext` with structured output

**Files:**
- Modify: `electron/main/utils/translate.ts`

- [ ] **Step 1: Add `AnalysisResult` type and schema after the existing imports (after line 8)**

```typescript
const analysisSchema = z.object({
  plotSummary: z.string(),
  glossary: z.array(
    z.object({
      term: z.string(),
      translation: z.string(),
    })
  ),
});

type AnalysisResult = z.infer<typeof analysisSchema>;
```

- [ ] **Step 2: Replace the entire `analyzeSubtitlesForContext` function (lines 379–435)**

Remove the existing function and replace with:

```typescript
async function analyzeSubtitlesForContext(
  subtitles: string[],
  {
    apiKeys,
    apiHost,
    model,
    lang,
    temperature = 0.3,
  }: {
    apiKeys: string[];
    apiHost: string;
    model: string;
    lang: string;
    temperature?: number;
  }
): Promise<AnalysisResult> {
  if (apiKeys.length === 0) {
    throw new Error("No valid API keys provided");
  }
  const ai = getAi({ apiKey: apiKeys[0], apiHost });

  const { object } = await generateObject({
    model: ai(model),
    temperature,
    schema: analysisSchema,
    system: `You are a subtitle content analyst for a translation system.
Analyze the provided subtitle sample and return:
1. plotSummary: A ${lang} narrative (5–10 sentences) describing what happens. Write naturally, not as a literal stitch of subtitles.
2. glossary: Up to 30 entries for character names, places, organizations, jargon, or fictional terms. For each, provide the term as it appears and its preferred ${lang} translation or rendering. If no translation exists, repeat the original term.`,
    prompt: `Analyze this subtitle sample:\n\n` + subtitles.join("\n"),
    maxRetries: 2,
  });

  return object;
}
```

- [ ] **Step 3: Remove `deduplicateLines` function (lines 365–377)**

Delete the entire `deduplicateLines` function — it is no longer called after this rewrite.

- [ ] **Step 4: Add `synthesizePlotSummaries` function after `analyzeSubtitlesForContext`**

```typescript
async function synthesizePlotSummaries(
  summaries: string[],
  {
    apiKeys,
    apiHost,
    model,
    lang,
    temperature = 0.3,
  }: {
    apiKeys: string[];
    apiHost: string;
    model: string;
    lang: string;
    temperature?: number;
  }
): Promise<string> {
  if (apiKeys.length === 0 || summaries.length === 0) {
    return summaries.join("\n\n");
  }
  const ai = getAi({ apiKey: apiKeys[0], apiHost });

  const numbered = summaries
    .map((s, i) => `[Part ${i + 1}]\n${s}`)
    .join("\n\n");

  const result = await generateText({
    model: ai(model),
    temperature,
    system: `You are a plot summarizer. Combine the provided partial summaries into one coherent ${lang} narrative. Preserve chronological order. Do not introduce information not present in the parts.`,
    prompt: `Synthesize these partial summaries into one coherent summary:\n\n${numbered}`,
    maxRetries: 2,
  });

  return result.text;
}
```

- [ ] **Step 5: Update the export list at the bottom of the file**

Replace:
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
with:
```typescript
export type { AnalysisResult };
export {
  translateSubtitleChunk,
  translateSubtitleSingle,
  parseSubtitle,
  saveTranslated,
  splitIntoChunk,
  analyzeSubtitlesForContext,
  synthesizePlotSummaries,
};
```

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -30
```
Expected: no errors related to `translate.ts`.

- [ ] **Step 7: Commit**

```bash
git add electron/main/utils/translate.ts
git commit -m "refactor(analyze): structured output via generateObject, add synthesizePlotSummaries"
```

---

## Task 3: Add parallel analysis pipeline to `index.ts`

**Files:**
- Modify: `electron/main/index.ts`

- [ ] **Step 1: Update the import from `translate.ts`**

In `electron/main/index.ts`, replace the existing import:
```typescript
import {
  splitIntoChunk,
  parseSubtitle,
  translateSubtitleChunk,
  translateSubtitleSingle,
  saveTranslated,
  analyzeSubtitlesForContext,
} from "./utils/translate";
```
with:
```typescript
import type { AnalysisResult } from "./utils/translate";
import {
  splitIntoChunk,
  parseSubtitle,
  translateSubtitleChunk,
  translateSubtitleSingle,
  saveTranslated,
  analyzeSubtitlesForContext,
  synthesizePlotSummaries,
} from "./utils/translate";
```

- [ ] **Step 2: Add constants and helpers after the `hashContent` function (after line ~155)**

```typescript
const ANALYSIS_SECTIONS = 3;

function mergeGlossaries(
  glossaries: Array<Array<{ term: string; translation: string }>>
): Array<{ term: string; translation: string }> {
  const seen = new Set<string>();
  const merged: Array<{ term: string; translation: string }> = [];
  for (const glossary of glossaries) {
    for (const entry of glossary) {
      const key = entry.term.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(entry);
      }
    }
  }
  return merged;
}

function formatAnalysisContext(analysis: AnalysisResult): string {
  const glossaryLines = analysis.glossary
    .map((g) => `- ${g.term}: ${g.translation}`)
    .join("\n");
  return `[Context]\n## Plot Summary\n${analysis.plotSummary}\n## Glossary\n${glossaryLines}`;
}

function isLocalModel(apiHost: string): boolean {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|::1/.test(apiHost);
}
```

- [ ] **Step 3: Verify the helpers with a quick test**

```bash
node -e "
function mergeGlossaries(glossaries) {
  const seen = new Set();
  const merged = [];
  for (const g of glossaries) {
    for (const e of g) {
      const key = e.term.toLowerCase();
      if (!seen.has(key)) { seen.add(key); merged.push(e); }
    }
  }
  return merged;
}
function isLocalModel(apiHost) {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|::1/.test(apiHost);
}
const merged = mergeGlossaries([
  [{term:'John',translation:'約翰'},{term:'NEXUS',translation:'NEXUS'}],
  [{term:'john',translation:'John重複'},{term:'New',translation:'新'}]
]);
console.assert(merged.length === 3, 'FAIL: dedup should produce 3 entries, got ' + merged.length);
console.assert(merged[0].translation === '約翰', 'FAIL: first occurrence should win');
console.assert(isLocalModel('http://localhost:1234') === true, 'FAIL: localhost should be local');
console.assert(isLocalModel('https://api.openai.com/v1') === false, 'FAIL: openai should not be local');
console.log('All assertions passed');
"
```
Expected: `All assertions passed`

- [ ] **Step 4: Replace the analysis block inside `processFile`**

Locate the current analysis block (begins with `// Build analysis context` around line 298, ends around line 351). Replace the entire block from `let combinedAdditional = params.additional || "";` through the closing `}` of the outer try/catch with:

```typescript
let combinedAdditional = params.additional || "";
let analysisData: AnalysisResult | null = null;

try {
  let usedCache = false;

  if (!params.forceReanalyze && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (
        cached.contentHash === fileHash &&
        cached.analysis &&
        typeof cached.analysis === "object"
      ) {
        analysisData = cached.analysis as AnalysisResult;
        usedCache = true;
      }
    } catch {}
  }

  if (!usedCache) {
    const sectionSize = Math.ceil(allTexts.length / ANALYSIS_SECTIONS);
    const sections = Array.from({ length: ANALYSIS_SECTIONS }, (_, i) =>
      allTexts.slice(i * sectionSize, (i + 1) * sectionSize)
    ).filter((s) => s.length > 0);

    const sectionResults = await Promise.all(
      sections.map((section) =>
        analyzeSubtitlesForContext(section, {
          apiKeys: params.apiKeys || [],
          apiHost: params.apiHost || "https://api.openai.com/v1",
          model: params.model || "",
          lang: params.lang || "",
          temperature: 0.3,
        }).catch(() => null)
      )
    );

    const validResults = sectionResults.filter(
      (r): r is AnalysisResult => r !== null
    );

    if (validResults.length > 0) {
      const mergedGlossary = mergeGlossaries(
        validResults.map((r) => r.glossary)
      );
      const summaries = validResults.map((r) => r.plotSummary);

      let plotSummary: string;
      if (summaries.length === 1) {
        plotSummary = summaries[0];
      } else {
        try {
          plotSummary = await synthesizePlotSummaries(summaries, {
            apiKeys: params.apiKeys || [],
            apiHost: params.apiHost || "https://api.openai.com/v1",
            model: params.model || "",
            lang: params.lang || "",
            temperature: 0.3,
          });
        } catch {
          plotSummary = summaries
            .map((s, i) => `[Act ${i + 1}]\n${s}`)
            .join("\n\n");
        }
      }

      analysisData = { plotSummary, glossary: mergedGlossary };

      try {
        fs.writeFileSync(
          cacheFile,
          JSON.stringify({ contentHash: fileHash, analysis: analysisData }),
          "utf8"
        );
      } catch {}
    }
  }

  if (analysisData) {
    combinedAdditional = `${
      combinedAdditional ? combinedAdditional + "\n\n" : ""
    }${formatAnalysisContext(analysisData)}`;
    analysisCache.set(file.path, analysisData);
    event.sender.send("batch-progress", {
      filePath: file.path,
      progress: 4,
      status: "analyzing",
      totalCues,
      currentCue: 0,
      analysis: analysisData,
    });
  }
} catch (analysisErr) {
  console.warn("Context analysis failed, continue without it:", analysisErr);
}
```

- [ ] **Step 5: Remove the old `analysisData` variable that was declared separately**

Find and remove this line near the beginning of the old analysis block (it should now be gone after Step 4, but verify):
```typescript
let analysisData: any = null;
```
(This is now declared inside the new block — if it still exists outside, remove it.)

- [ ] **Step 6: Update the two remaining `analysis: analysisData` references after the analysis block**

After the analysis block, there are two `event.sender.send("batch-progress", {..., analysis: analysisData})` calls (one at the start of translation, one at completion). Both still reference `analysisData` which is now typed as `AnalysisResult | null` — no code change needed, just verify they still compile.

- [ ] **Step 7: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -30
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add electron/main/index.ts
git commit -m "feat(analyze): parallel sectioned analysis with synthesis and structured cache"
```

---

## Task 4: Add concurrency auto-detection to `index.ts`

**Files:**
- Modify: `electron/main/index.ts`

- [ ] **Step 1: Replace the `pool(10, chunks, chunkProcessor)` call**

Find (around line 525):
```typescript
for await (const _ of pool(10, chunks, chunkProcessor)) {
```

Replace with:
```typescript
const defaultConcurrency = isLocalModel(params.apiHost || "") ? 3 : 10;
const concurrency =
  typeof params.concurrentRequests === "number"
    ? Math.max(1, Math.min(20, params.concurrentRequests))
    : defaultConcurrency;

for await (const _ of pool(concurrency, chunks, chunkProcessor)) {
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -30
```
Expected: no errors.

- [ ] **Step 3: Verify concurrency detection via console log (temporary)**

Add a temporary log line just before the pool call:
```typescript
console.log(`[concurrency] apiHost=${params.apiHost} local=${isLocalModel(params.apiHost || "")} pool=${concurrency}`);
```
Start a translation with `apiHost = "http://localhost:1234"`. Console should show `pool=3`.
Start a translation with cloud URL. Console should show `pool=10`.

Remove the temporary log after verification.

- [ ] **Step 4: Commit**

```bash
git add electron/main/index.ts
git commit -m "feat(translate): auto-detect local model and set concurrency accordingly"
```

---

## Task 5: Update renderer to display structured analysis

**Files:**
- Modify: `src/components/TranslatorPanel.tsx`

- [ ] **Step 1: Update `ProgressType` interface**

Find the `ProgressType` interface (around line 17). Replace:
```typescript
analysis?: string;
```
with:
```typescript
analysis?: { plotSummary: string; glossary: Array<{ term: string; translation: string }> };
```

- [ ] **Step 2: Replace the analysis display in the modal**

Find this block (around line 499–509):
```tsx
{selectedAnalysis && (
  <div className="mb-4">
    <div className="text-md font-semibold">
      {t("translate.context.title")}
    </div>
    <p className="text-sm whitespace-pre-wrap">
      {selectedAnalysis}
    </p>

    <hr className="my-2" />
  </div>
)}
```

Replace with:
```tsx
{selectedAnalysis && (
  <div className="mb-4">
    <div className="text-md font-semibold mb-1">
      {t("translate.context.title")}
    </div>
    <div className="text-sm font-medium text-slate-700">
      {t("translate.context.plot_summary")}
    </div>
    <p className="text-sm whitespace-pre-wrap mb-2">
      {selectedAnalysis.plotSummary}
    </p>
    {selectedAnalysis.glossary.length > 0 && (
      <>
        <div className="text-sm font-medium text-slate-700">
          {t("translate.context.glossary")}
        </div>
        <ul className="text-sm mt-1 space-y-0.5">
          {selectedAnalysis.glossary.map((g, i) => (
            <li key={i}>
              <span className="font-medium">{g.term}</span>: {g.translation}
            </li>
          ))}
        </ul>
      </>
    )}
    <hr className="my-2" />
  </div>
)}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -30
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/TranslatorPanel.tsx
git commit -m "feat(ui): display structured analysis with plot summary and glossary"
```

---

## Task 6: Add Concurrent Requests settings UI

**Files:**
- Create: `src/components/settings/ConcurrentRequests.tsx`
- Modify: `src/pages/settings.tsx`
- Modify: `src/components/TranslatorPanel.tsx`
- Modify: `src/locales/en-US.json`
- Modify: `src/locales/zh-TW.json`
- Modify: `src/locales/zh-CN.json`

- [ ] **Step 1: Add i18n keys to `src/locales/en-US.json`**

Add after the `"delay"` block:
```json
"concurrent_requests": {
  "title": "Concurrent Requests",
  "description": "Number of subtitle chunks processed in parallel. Lower values (2–3) work better for local models. Leave empty to auto-detect (3 for local, 10 for cloud API)."
},
```

- [ ] **Step 2: Add i18n keys to `src/locales/zh-TW.json`**

Add after the `"delay"` block:
```json
"concurrent_requests": {
  "title": "同時請求數",
  "description": "同時處理的字幕區塊數量。本地模型建議設為 2–3，留空則自動偵測（本地模型預設 3，雲端 API 預設 10）。"
},
```

- [ ] **Step 3: Add i18n keys to `src/locales/zh-CN.json`**

Add after the `"delay"` block:
```json
"concurrent_requests": {
  "title": "并发请求数",
  "description": "同时处理的字幕块数量。本地模型建议设置 2–3，留空则自动检测（本地模型默认 3，云端 API 默认 10）。"
},
```

- [ ] **Step 4: Create `src/components/settings/ConcurrentRequests.tsx`**

```tsx
import Title from "../Title";
import { useTranslation } from "react-i18next";
import { useLocalStorage } from "usehooks-ts";

export default function ConcurrentRequests() {
  const [concurrentRequests, setConcurrentRequests] = useLocalStorage<
    number | undefined
  >("concurrent_requests", undefined);
  const { t } = useTranslation();

  return (
    <div className="bg-white rounded flex justify-between items-center border border-slate-200 p-4 gap-8">
      <div className="flex flex-col">
        <Title>{t("concurrent_requests.title")}</Title>
        <div className="text-sm text-slate-600">
          {t("concurrent_requests.description")}
        </div>
      </div>
      <div className="flex items-center gap-4 w-80 shrink-0">
        <input
          type="number"
          value={concurrentRequests?.toString() ?? ""}
          onChange={(e) => {
            const val = e.target.valueAsNumber;
            setConcurrentRequests(
              isNaN(val) ? undefined : Math.max(1, Math.min(20, val))
            );
          }}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-slate-500"
          placeholder="auto"
          min="1"
          max="20"
          step="1"
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Add `<ConcurrentRequests />` to `src/pages/settings.tsx`**

Replace the file content:
```tsx
import Language from "@/components/settings/Language";
import Model from "@/components/settings/Model";
import API from "@/components/settings/API";
import Save from "@/components/settings/Save";
import Prompt from "@/components/settings/Prompt";
import Reset from "@/components/settings/Reset";
import Delay from "@/components/settings/Delay";
import ConcurrentRequests from "@/components/settings/ConcurrentRequests";

export default function Settings() {
  return (
    <div className="h-[calc(100vh-48px)] overflow-y-auto">
      <div className="p-4 flex flex-col gap-2">
        <Language />
        <API />
        <Delay />
        <ConcurrentRequests />
        <Save />
        <Model />
        <Prompt />
        <Reset />
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Pass `concurrentRequests` from `TranslatorPanel.tsx` to IPC params**

In `src/components/TranslatorPanel.tsx`, add after the `const [multiLangSave]` line (around line 50):
```typescript
const [concurrentRequests] = useLocalStorage<number | undefined>(
  "concurrent_requests",
  undefined
);
```

Then in the `params` object inside `executeBatchTranslation` (around line 123), add `concurrentRequests`:
```typescript
const params = {
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
};
```

- [ ] **Step 7: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -30
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/settings/ConcurrentRequests.tsx src/pages/settings.tsx src/components/TranslatorPanel.tsx src/locales/en-US.json src/locales/zh-TW.json src/locales/zh-CN.json
git commit -m "feat(settings): add Concurrent Requests setting with auto-detect default"
```

---

## Verification Checklist (run after all tasks)

```bash
# Type-check the whole project
npx tsc --noEmit
```

Then run the app in dev mode (`npm run dev`) and verify:

| Check | How |
|---|---|
| Version update no longer triggers on 1.8.0 | Check update toast does not appear if latest release tag is older than local version |
| Analysis completes faster | Start translation on a long film; watch console timestamps from "analyzing" to "translating" |
| Cache file stores object | Open `.analysis.json` next to a subtitle file; confirm `analysis` is an object not a string |
| Glossary has no duplicates | Inspect `.analysis.json` — no two entries share the same `term` (case-insensitive) |
| Local model uses pool=3 | Temporarily add `console.log('pool:', concurrency)` in `index.ts`; start with localhost apiHost |
| Cloud API uses pool=10 | Same test with a cloud URL |
| Settings page shows Concurrent Requests | Open Settings; verify the new field appears between Delay and Bilingual Subtitles |
| Analysis modal shows structured view | Translate a file; open the progress modal; confirm Plot Summary and Glossary sections render separately |
