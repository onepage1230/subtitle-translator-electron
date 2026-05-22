# Analysis & Concurrency Optimization Design

**Date**: 2026-05-22
**Status**: Approved

## Problem Statement

Two independent performance issues:

1. **Global analysis (analyzeSubtitlesForContext) takes 10–20 minutes for feature-length films.**
   Root cause: all subtitle lines (~1500 for a long film) are sent in a single `generateText` call, producing 10,000+ token input. Local model prefill is extremely slow at this size. Output is also unstructured free-text, requiring a `deduplicateLines` workaround and producing inconsistent glossary entries.

2. **Translation throughput degrades smoothly from ~8 concurrent requests to 1 over time.**
   Root cause: `pool(10)` sends 10 simultaneous requests to the local model (oMLX), which has a fixed compute budget. All 10 requests compete for the same resources. As early chunks complete, only the slower ones remain, making it appear as a steady drop. No retry warnings appear — this is pure model saturation, not a backoff issue.

**Bonus bug**: Version update check always triggers because `tag_name` from GitHub API (e.g. `v1.8.0`) is compared to the local version string (e.g. `1.9.0`) using `!=` — a string comparison that is always unequal due to the `v` prefix. There is also no semver ordering check, so older releases would trigger a false update notice.

---

## Design

### 1. Analysis: Parallel Sectioned Analysis with Synthesis

**New flow** (replaces `analyzeSubtitlesForContext` single-call approach):

```
allTexts (all subtitle lines)
  ↓ split evenly into 3 sections (each ≈ Math.ceil(total/3) lines; last section may be shorter)
  ↓ Promise.all × 3  (parallel)
    each section → generateObject + zod schema
    returns: { plotSummary: string, glossary: GlossaryItem[] }
  ↓ merge
    glossary: deduplicate by term (case-insensitive), keep first occurrence
    plotSummary × 3 → one synthesis AI call → single coherent summary
  ↓ format for injection into translation prompt:
    [Context]
    ## Plot Summary
    {synthesized summary}
    ## Glossary
    - {term}: {preferredTranslation ?? description}
    ...
```

**Structured output schema** (zod):
```typescript
z.object({
  plotSummary: z.string(),
  glossary: z.array(z.object({
    term: z.string(),
    description: z.string(),
    preferredTranslation: z.string().optional(),
  }))
})
```

**Synthesis call**: Takes the three `plotSummary` strings as input, asks the model to produce one coherent narrative. Input is ~300–600 tokens; expected to complete in under 15 seconds. Uses the same model and API key as analysis.

**Glossary injection**: Only `term` and `preferredTranslation` (falling back to `description`) are injected into each translation chunk prompt. The `description` field is stored in the cache but omitted from the per-chunk context to keep prompt size small.

**Expected improvement**: 10–20 min → ~2–4 min (3 parallel sections + one lightweight synthesis call).

**Cache format change**: The on-disk `.analysis.json` cache stores the merged structured result:
```json
{
  "contentHash": "...",
  "analysis": {
    "plotSummary": "...",
    "glossary": [{ "term": "...", "description": "...", "preferredTranslation": "..." }]
  }
}
```
Existing caches with the old string format will be treated as a cache miss (graceful fallback to re-analysis).

---

### 2. Concurrency: Auto-Detection + User Override

**Auto-detection logic**:
```typescript
function isLocalModel(apiHost: string): boolean {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|::1/.test(apiHost);
}

const defaultConcurrency = isLocalModel(params.apiHost) ? 3 : 10;
const concurrency = params.concurrentRequests ?? defaultConcurrency;
```

Applied to the chunk pool in `batch-translate`:
```typescript
for await (const _ of pool(concurrency, chunks, chunkProcessor)) { ... }
```

**Settings page**: Add a "Concurrent Requests" number input (range 1–20, step 1).
- `localStorage` key: `concurrent_requests`
- Description shown in UI: note that lower values work better for local models; leave blank to use auto-detected default.
- Empty / unset = use auto-detected default (3 for local, 10 for cloud).

**i18n**: Add `concurrent_requests` keys to all three locale files (en-US, zh-TW, zh-CN).

---

### 3. Version Comparison Bug Fix

**Current code** (`src/layouts/default.tsx`):
```typescript
if (version && newVersion && version != newVersion) { ... }
```

**Problem**: `tag_name` from GitHub API includes a `v` prefix (e.g. `v1.9.0`). String inequality is always true. No ordering check means older releases trigger false update notices.

**Fix**: Replace the comparison with a semver-aware function:
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

Replace both occurrences of `version != newVersion` with `isNewerVersion(newVersion, version)` (one inside `useEffect`, one in the JSX return).

---

## Files Changed

| File | Change |
|---|---|
| `electron/main/utils/translate.ts` | Rewrite `analyzeSubtitlesForContext`: add zod schema, switch to `generateObject`, add synthesis helper |
| `electron/main/index.ts` | Parallel section split, Promise.all analysis, synthesis call, cache format update, `isLocalModel` detection, concurrency parameter |
| `src/pages/settings.tsx` | Add Concurrent requests number input |
| `src/hooks/useLocalStorage.ts` (or equivalent) | `concurrent_requests` key consumed by settings |
| `src/locales/en-US.json` | Add `concurrent_requests` i18n keys |
| `src/locales/zh-TW.json` | Add `concurrent_requests` i18n keys |
| `src/locales/zh-CN.json` | Add `concurrent_requests` i18n keys |
| `src/layouts/default.tsx` | Replace version comparison with `isNewerVersion` |

---

## Error Handling

- **Any of the 3 parallel analysis calls fails**: that section is omitted from the merge; remaining sections still proceed. If all 3 fail, analysis returns empty string (existing behavior).
- **Synthesis call fails**: fall back to labeled concatenation (`[Act 1] ... [Act 2] ... [Act 3] ...`) rather than blocking translation.
- **Cache format mismatch**: if `cached.analysis` is a string (old format) instead of an object, treat as cache miss and re-run analysis.
- **`concurrent_requests` out of range**: clamp to [1, 20] before use.

---

## Out of Scope

- Dynamic (runtime-adaptive) concurrency adjustment
- Progress reporting for individual analysis sections
- Retry backoff timing improvements (`retryTranslate` default delay remains 1000ms)
