# Analysis Cache + Glossary Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skip redundant AI analysis on resume by caching results to disk, and eliminate duplicate glossary lines in analysis output.

**Architecture:** Add `deduplicateLines()` in `translate.ts`; add SHA-256 cache read/write + new `check-analysis-cache` IPC in `index.ts`; refactor renderer's `startBatchTranslation` to check cache and show a confirm dialog before invoking `batch-translate`.

**Tech Stack:** Node.js `crypto` (built-in), Electron IPC, React state + JSX, react-i18next

---

### Task 1: Add `deduplicateLines` to `translate.ts`

**Files:**
- Modify: `electron/main/utils/translate.ts:365-421`

- [ ] **Step 1: Add the function above `analyzeSubtitlesForContext`**

  Insert this block at line 365, immediately before the existing `async function analyzeSubtitlesForContext`:

  ```typescript
  function deduplicateLines(text: string): string {
    const seen = new Set<string>();
    return text
      .split('\n')
      .filter(line => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        if (seen.has(trimmed)) return false;
        seen.add(trimmed);
        return true;
      })
      .join('\n');
  }
  ```

- [ ] **Step 2: Apply it to the return value inside `analyzeSubtitlesForContext`**

  In the `try` block of `analyzeSubtitlesForContext`, change:
  ```typescript
      return result.text;
  ```
  to:
  ```typescript
      return deduplicateLines(result.text);
  ```

- [ ] **Step 3: Verify TypeScript compiles**

  ```bash
  cd /Users/onepage/Documents/github/subtitle-translator-electron
  npx tsc --noEmit
  ```
  Expected: no errors related to `translate.ts`.

- [ ] **Step 4: Commit**

  ```bash
  git add electron/main/utils/translate.ts
  git commit -m "fix(analyze): deduplicate repeated lines in analysis output"
  ```

---

### Task 2: Add `hashContent` helper + `check-analysis-cache` IPC

**Files:**
- Modify: `electron/main/index.ts:1-5` (add import), `electron/main/index.ts:150-151` (add helper + handler)

- [ ] **Step 1: Add `crypto` import**

  In `electron/main/index.ts`, after the existing imports (line 5), add:
  ```typescript
  import crypto from "node:crypto";
  ```
  The imports block should now read:
  ```typescript
  import { app, BrowserWindow, shell, ipcMain } from "electron";
  import { release } from "node:os";
  import { join } from "node:path";
  import fs from "node:fs";
  import path from "node:path";
  import crypto from "node:crypto";
  import pool from "tiny-async-pool";
  ```

- [ ] **Step 2: Add `hashContent` helper and `check-analysis-cache` handler**

  After the line `const analysisCache = new Map<string, any>();` (line 150), insert:

  ```typescript
  function hashContent(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  ipcMain.handle("check-analysis-cache", async (_, filePaths: string[]) => {
    const cached: string[] = [];
    for (const filePath of filePaths) {
      const cacheFile = filePath.replace(/\.[^/.]+$/, "") + ".analysis.json";
      if (!fs.existsSync(cacheFile)) continue;
      try {
        const { contentHash, analysis } = JSON.parse(
          fs.readFileSync(cacheFile, "utf8")
        );
        const fileContent = fs.readFileSync(filePath, "utf8");
        if (contentHash === hashContent(fileContent) && analysis) {
          cached.push(filePath);
        }
      } catch {}
    }
    return cached;
  });
  ```

- [ ] **Step 3: Verify TypeScript compiles**

  ```bash
  npx tsc --noEmit
  ```
  Expected: no errors.

- [ ] **Step 4: Commit**

  ```bash
  git add electron/main/index.ts
  git commit -m "feat(ipc): add check-analysis-cache handler with SHA-256 validation"
  ```

---

### Task 3: Cache read/write inside `processFile`

**Files:**
- Modify: `electron/main/index.ts:200-310` (`processFile` function)

- [ ] **Step 1: Compute hash and cache path right after reading file content**

  At line ~209, the file content is already read:
  ```typescript
  const content = fs.readFileSync(file.path, "utf8");
  ```

  Immediately after that line, add:
  ```typescript
  const fileHash = hashContent(content);
  const cacheFile = file.path.replace(/\.[^/.]+$/, "") + ".analysis.json";
  ```

- [ ] **Step 2: Replace the analysis block to use cache**

  Find and replace the entire block starting with:
  ```typescript
      let combinedAdditional = params.additional || "";
      let analysisData: any = null;
      try {
        const analysis = await analyzeSubtitlesForContext(allTexts, {
  ```
  through the closing `} catch (analysisErr) { ... }`.

  Replace with:
  ```typescript
      let combinedAdditional = params.additional || "";
      let analysisData: any = null;
      try {
        let analysis = "";
        let usedCache = false;
        if (!params.forceReanalyze && fs.existsSync(cacheFile)) {
          try {
            const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
            if (cached.contentHash === fileHash && cached.analysis) {
              analysis = cached.analysis;
              usedCache = true;
            }
          } catch {}
        }
        if (!usedCache) {
          analysis = await analyzeSubtitlesForContext(allTexts, {
            apiKeys: params.apiKeys || [],
            apiHost: params.apiHost || "https://api.openai.com/v1",
            model: params.model || "",
            lang: params.lang || "",
            temperature: 0.3,
          });
          try {
            fs.writeFileSync(
              cacheFile,
              JSON.stringify({ contentHash: fileHash, analysis }),
              "utf8"
            );
          } catch {}
        }
        combinedAdditional = `${
          combinedAdditional ? combinedAdditional + "\n\n" : ""
        }[Context]\n${analysis}`;
        analysisData = analysis;
        analysisCache.set(file.path, analysis);
        event.sender.send("batch-progress", {
          filePath: file.path,
          progress: 4,
          status: "analyzing",
          totalCues,
          currentCue: 0,
          analysis,
        });
      } catch (analysisErr) {
        console.warn(
          "Context analysis failed, continue without it:",
          analysisErr
        );
      }
  ```

- [ ] **Step 3: Verify TypeScript compiles**

  ```bash
  npx tsc --noEmit
  ```
  Expected: no errors. (`params.forceReanalyze` may be `undefined` at this point — that's fine, `!undefined` is `true`, which means cache is checked by default.)

- [ ] **Step 4: Commit**

  ```bash
  git add electron/main/index.ts
  git commit -m "feat(translate): cache analysis result to disk, skip on resume"
  ```

---

### Task 4: Renderer dialog + i18n keys

**Files:**
- Modify: `src/locales/en-US.json:114`
- Modify: `src/locales/zh-TW.json:114`
- Modify: `src/locales/zh-CN.json:114`
- Modify: `src/components/TranslatorPanel.tsx`

- [ ] **Step 1: Add i18n keys to all three locale files**

  In `src/locales/en-US.json`, before the closing `}` of the `translate` object (after `"done_with_failures"` line), add:
  ```json
      "reanalyze_dialog": {
        "message": "{{count}} file(s) have a cached analysis. Re-analyze?",
        "hint": "Files without a cache will be analyzed automatically.",
        "reanalyze": "Re-analyze",
        "use_cache": "Use cached"
      }
  ```

  In `src/locales/zh-TW.json`, same position:
  ```json
      "reanalyze_dialog": {
        "message": "偵測到 {{count}} 個檔案有先前的分析結果，是否重新分析？",
        "hint": "無快取的檔案將自動分析。",
        "reanalyze": "重新分析",
        "use_cache": "使用快取"
      }
  ```

  In `src/locales/zh-CN.json`, same position:
  ```json
      "reanalyze_dialog": {
        "message": "检测到 {{count}} 个档案有先前的分析结果，是否重新分析？",
        "hint": "无缓存的档案将自动分析。",
        "reanalyze": "重新分析",
        "use_cache": "使用缓存"
      }
  ```

- [ ] **Step 2: Add two new state variables in `TranslatorPanel.tsx`**

  After the existing `const [modalOpen, setModalOpen] = useState(false);` (line 58), add:
  ```typescript
  const [reanalyzeDialogOpen, setReanalyzeDialogOpen] = useState(false);
  const [cachedCount, setCachedCount] = useState(0);
  ```

- [ ] **Step 3: Refactor `startBatchTranslation` into two functions**

  Replace the entire `startBatchTranslation` function (lines 110–147) with:

  ```typescript
  const executeBatchTranslation = async (forceReanalyze: boolean) => {
    setIsTranslating(true);
    setBatchProgress(
      files.reduce<Record<string, ProgressType>>(
        (acc, f) => ({
          ...acc,
          [f.path]: { progress: 0, status: "pending" as const },
        }),
        {}
      )
    );
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
    };
    try {
      await ipcRenderer.invoke("batch-translate", { files, params });
      setIsTranslating(false);
    } catch (e: unknown) {
      const error = e as Error;
      toast.error(`Batch translation failed: ${error.message}`);
      setIsTranslating(false);
    }
  };

  const startBatchTranslation = async () => {
    if (
      files.length === 0 ||
      keys.filter((k: string) => k.length > 0).length === 0
    ) {
      toast.error("No API keys configured");
      return;
    }
    const filePaths = files.map((f) => f.path);
    const cachedPaths: string[] = await ipcRenderer.invoke(
      "check-analysis-cache",
      filePaths
    );
    if (cachedPaths.length > 0) {
      setCachedCount(cachedPaths.length);
      setReanalyzeDialogOpen(true);
      return;
    }
    executeBatchTranslation(false);
  };
  ```

- [ ] **Step 4: Add the dialog JSX**

  After the `{/* Modal */}` block (around line 461), add:

  ```jsx
  {/* Reanalyze dialog */}
  {reanalyzeDialogOpen && (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white p-6 rounded max-w-sm w-full mx-4 shadow-xl">
        <p className="mb-1">
          {t("translate.reanalyze_dialog.message", { count: cachedCount })}
        </p>
        <p className="text-sm text-gray-500 mb-4">
          {t("translate.reanalyze_dialog.hint")}
        </p>
        <div className="flex gap-2 justify-end">
          <Button
            onClick={() => {
              setReanalyzeDialogOpen(false);
              executeBatchTranslation(true);
            }}
          >
            {t("translate.reanalyze_dialog.reanalyze")}
          </Button>
          <Button
            onClick={() => {
              setReanalyzeDialogOpen(false);
              executeBatchTranslation(false);
            }}
          >
            {t("translate.reanalyze_dialog.use_cache")}
          </Button>
        </div>
      </div>
    </div>
  )}
  ```

- [ ] **Step 5: Verify TypeScript compiles**

  ```bash
  npx tsc --noEmit
  ```
  Expected: no errors.

- [ ] **Step 6: Commit**

  ```bash
  git add src/locales/en-US.json src/locales/zh-TW.json src/locales/zh-CN.json src/components/TranslatorPanel.tsx
  git commit -m "feat(ui): add reanalyze confirm dialog, pass forceReanalyze to batch-translate"
  ```

---

## Self-Review

**Spec coverage:**
- ✅ `deduplicateLines` applied to `analyzeSubtitlesForContext` output (Task 1)
- ✅ `.analysis.json` cache with SHA-256 hash (Tasks 2 & 3)
- ✅ `check-analysis-cache` IPC (Task 2)
- ✅ Dialog with "重新分析" / "使用快取" buttons (Task 4)
- ✅ `forceReanalyze` semantics: `false` → skip files with valid cache; `true` → all re-analyze (Task 3)
- ✅ Files without cache always run analysis (Task 3: `!usedCache` branch)
- ✅ i18n for all 3 locales (Task 4)

**Placeholder scan:** None found.

**Type consistency:**
- `hashContent(content: string): string` defined in Task 2, used in Tasks 2 & 3 ✅
- `cacheFile` computed in Task 3 Step 1, used in Task 3 Step 2 ✅
- `executeBatchTranslation(forceReanalyze: boolean)` defined and called consistently ✅
- `params.forceReanalyze` read in main process Task 3; set in renderer Task 4 ✅
