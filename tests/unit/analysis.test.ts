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
    glossary: [{ term: "Neo", translation: "尼歐", category: "person" }],
  } as any);
  vi.mocked(translate.synthesizePlotSummaries).mockReset().mockResolvedValue("synth");
});

describe("mergeGlossaries", () => {
  it("dedupes case-insensitively, first wins", () => {
    const merged = mergeGlossaries([
      [{ term: "Neo", translation: "尼歐", category: "person" }],
      [
        { term: "neo", translation: "紐", category: "person" },
        { term: "Trinity", translation: "崔妮蒂", category: "person" },
      ],
    ]);
    expect(merged).toEqual([
      { term: "Neo", translation: "尼歐", category: "person" },
      { term: "Trinity", translation: "崔妮蒂", category: "person" },
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
});
