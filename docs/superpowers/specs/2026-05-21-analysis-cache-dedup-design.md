# Analysis Cache + Glossary Dedup Design

**Date:** 2026-05-21  
**Status:** Approved

## Problem

Two issues with `analyzeSubtitlesForContext`:

1. **Redundant re-analysis on resume**: Every call to `processFile` unconditionally runs `analyzeSubtitlesForContext`, even when resuming a partially translated file in the same session. The existing `analysisCache` is write-only within `processFile` — it is never consulted before running the analysis.

2. **Duplicate glossary entries**: The analysis output (raw text) contains the same glossary term repeated dozens of times. The AI generates a new entry for each occurrence of a term in the subtitles rather than consolidating them.

## Design

### Issue 1: Disk Cache + User Dialog

**Cache file**: `<subtitle-name>.analysis.json` stored in the same directory as the subtitle file.

```json
{ "contentHash": "sha256-of-subtitle-content", "analysis": "..." }
```

Cache is valid when the subtitle file's SHA-256 hash matches `contentHash`. If the subtitle changes, the cache is stale and ignored.

**New IPC handler: `check-analysis-cache`**

- Input: `string[]` — array of subtitle file paths
- For each path: compute SHA-256 of file content, check for `.analysis.json`, compare hash
- Output: `string[]` — paths that have a valid (non-stale) cache entry

**Renderer flow (on "Start Translation" click)**:

1. Call `check-analysis-cache` with the selected file paths
2. If any files have valid cache → show confirm dialog:
   > "偵測到 N 個檔案有先前的分析結果，是否重新分析？（無快取的檔案將自動分析）"  
   > Buttons: 「重新分析」 / 「使用快取」
3. Pass `forceReanalyze: boolean` into `batch-translate` params

**Main process `processFile` changes**:

- Before calling `analyzeSubtitlesForContext`: if `!forceReanalyze` and a valid cache exists → load analysis from cache, skip API call
- After a successful analysis: write/overwrite `.analysis.json` with the new hash and result

**`forceReanalyze` semantics**:
- `false` (use cache): files with valid cache skip analysis; files without cache still run analysis
- `true` (re-analyze): all files run analysis regardless of cache

### Issue 2: Line-Level Deduplication

Add `deduplicateLines()` to `translate.ts` and apply it to the return value of `analyzeSubtitlesForContext`:

```typescript
function deduplicateLines(text: string): string {
  const seen = new Set<string>();
  return text
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      if (!trimmed) return true; // preserve blank lines
      if (seen.has(trimmed)) return false;
      seen.add(trimmed);
      return true;
    })
    .join('\n');
}
```

No prompt changes required. Handles exact-line duplicates (the observed failure mode) without any format assumptions.

## Files Changed

| File | Change |
|------|--------|
| `electron/main/index.ts` | Add `check-analysis-cache` IPC handler; modify `processFile` to read/write cache and respect `forceReanalyze` |
| `electron/main/utils/translate.ts` | Add `deduplicateLines`; apply to `analyzeSubtitlesForContext` return value |
| `src/` (Renderer) | Add cache check call + dialog before invoking `batch-translate`; pass `forceReanalyze` param |

## Success Criteria

- **Issue 1**: Resuming a file in the same session shows the dialog; choosing "使用快取" skips the analysis API call entirely
- **Issue 2**: `analyzeSubtitlesForContext` output contains no duplicate lines
