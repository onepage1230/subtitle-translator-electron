# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (starts Vite + Electron together)
npm run dev

# Build distributable (runs writeVersion.js, tsc, vite build, then electron-builder)
npm run build

# E2E tests (Playwright)
npm run pree2e   # build in test mode first
npm run e2e

# Unit tests (Vitest, test files in tests/unit/)
npm test
```

No lint script is defined; TypeScript type checking is done via `tsc` during build.

## Architecture

This is an **Electron + React** desktop app built with Vite. The two distinct runtime contexts are:

### Electron Main Process (`electron/main/`)
- **`index.ts`** — thin BrowserWindow setup + IPC handlers: `batch-translate`, `get-analysis`, `get-translated-content`, `get-subtitle-preview`, `check-analysis-cache`, `retry-file`; delegates the actual work to the four modules below
- **`utils/translate.ts`** — AI calls only: Vercel AI SDK (`@ai-sdk/openai-compatible`) chunk/single-line translation, tool-calling with `generateObject` JSON schema fallback
- **`utils/subtitle.ts`** — subtitle parsing/serialization: `parseSubtitle` (SRT/VTT/ASS/SSA), `saveTranslated` (atomic `.tmp` rename writes), `normalizeCues`, `splitIntoChunk`
- **`utils/analysis.ts`** — context analysis orchestration and caching: `getOrCreateAnalysis`, `hashContent`, `analysisCachePath`, `formatAnalysisContext`
- **`utils/pipeline.ts`** — translation flow orchestration: `translateFile` (parse → analyze → chunk → parallel translate with sliding context window → line-level fallback → save), `retryTranslate` (exponential backoff), `isLocalModel`
- **`electron/shared/subtitleKey.ts`** — `makeKey` helper for identifying cues by timestamp, shared between main-process modules and the renderer (TranslatorPanel imports it directly)

### Renderer Process (`src/`)
- React 18 + React Router (hash-based, three routes: `/`, `/settings`, `/about`)
- Redux Toolkit store (`src/store/`) manages only the file list in memory (not persisted)
- All other state (API keys, model, prompt, language, temperature, etc.) is persisted via `localStorage` using `usehooks-ts`'s `useLocalStorage`
- `src/hooks/useOpenAI.ts` — localStorage-backed settings hooks (API keys, host, provider, temperature)

### IPC Communication Pattern
Renderer invokes translation via `ipcRenderer.invoke("batch-translate", { files, params })`. Main process does the actual file I/O and AI calls, then pushes progress updates back via `ipcRenderer.send("batch-progress", data)`. The renderer listens with `ipcRenderer.on("batch-progress", handler)`.

**Note:** `nodeIntegration: true` and `contextIsolation: false` are set on the BrowserWindow — the renderer can import `electron` directly (e.g., `import { ipcRenderer } from "electron"`).

### Translation Pipeline (Main Process)
1. Parse subtitle file (`parseSubtitle`) → filter cues
2. Analyze all text for plot summary + glossary (`analyzeSubtitlesForContext`) — result prepended to every translation request as `[Context]`
3. Split into chunks of 20 (`splitIntoChunk`)
4. Parallel chunk processing (concurrency 10 via `tiny-async-pool`) with sliding context window (±5 cues around each chunk)
5. Each chunk: try tool-calling first, fall back to `generateObject` (JSON schema)
6. Retry with exponential backoff (`retryTranslate`) up to 5 attempts for network/rate-limit/schema errors
7. Line-by-line fallback (`translateSubtitleSingle`) for misaligned chunks
8. Atomic file writes after each chunk update (`.tmp` rename pattern) for live preview
9. Output saved as `<original-name>.translated.<ext>` in same directory

Series mode: subtitle files in the same folder share an accumulated glossary
(`.series-glossary.json`, first-wins, capped at 100 entries by category priority
person > organization > place > term). Files in the same folder are processed
sequentially (natural filename order); different folders run in parallel.
To reset the series glossary, delete `.series-glossary.json` AND re-analyze the episodes (the reanalyze dialog, or delete the per-file `.analysis.json` caches) — otherwise cached per-episode analyses will repopulate the old terms on the next run.

### Settings Persistence
All user settings use `localStorage` keys:
- `api_keys` — array of API key strings
- `api_host` — base URL (default: `https://api.openai.com/v1`)
- `api_provider` — enum: `openrouter | openai | vercel-gateway | openai-compatible`
- `model` — model ID (default: `gpt-4-turbo`)
- `translate_lang` — target language
- `translate_additional` — additional instructions appended to prompt
- `ai_temperature` — sampling temperature (default: 1)
- `multi_language_save` — `none | translate+original | original+translate`

### Supported Subtitle Formats
`.srt`, `.vtt` — parsed via `subtitle` npm package  
`.ass`, `.ssa` — parsed via `ass-parser` / `ass-stringify`

### Build Output
- `dist/` — Vite renderer bundle
- `dist-electron/` — compiled Electron main + preload
- `release/` — packaged distributables (dmg/nsis/AppImage)

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`onepage1230/subtitle-translator-electron`). See `docs/agents/issue-tracker.md`.

### Triage labels

Uses default five-role label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo: one `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.
