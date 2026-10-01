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
  alignPlotSummaryWithGlossary,
  readAnalysisCache,
  getOrCreateAnalysis,
  hashContent,
  analysisCachePath,
  filterGlossaryForText,
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

  it("marks the glossary as authoritative over the plot summary", () => {
    const s = formatAnalysisContext({
      plotSummary: "p",
      glossary: [{ term: "Hyunwoo", translation: "賢祐", category: "person" }],
    } as any);
    expect(s).toContain("## Glossary");
    expect(s).toContain("- Hyunwoo: 賢祐");
    expect(s).toContain("authoritative");
    expect(s).toContain("do not add the family name");
  });
});

describe("alignPlotSummaryWithGlossary", () => {
  const p = (term: string, translation: string) => ({
    term,
    translation,
    category: "person" as const,
  });

  it("replaces superseded translations in the summary", () => {
    const out = alignPlotSummaryWithGlossary(
      "金秀賢向慧仁告白，探望生病的慧仁。",
      [p("Hyein", "慧仁")],
      [p("Hyein", "海仁")]
    );
    expect(out).toBe("金秀賢向海仁告白，探望生病的海仁。");
  });

  it("replaces longer translations first to avoid partial overlap", () => {
    // 洪慧仁 → 洪惠仁 與 慧仁 → 海仁 同時存在：
    // 若先換短字串，洪慧仁會被改成洪海仁，長字串就找不到了
    const out = alignPlotSummaryWithGlossary(
      "洪慧仁和慧仁",
      [p("Hong Hye-in", "洪慧仁"), p("Hyein", "慧仁")],
      [p("Hong Hye-in", "洪惠仁"), p("Hyein", "海仁")]
    );
    expect(out).toBe("洪惠仁和海仁");
  });

  it("matches terms case-insensitively between cached and final glossaries", () => {
    const out = alignPlotSummaryWithGlossary(
      "大惠登場",
      [p("Da-hye", "大惠")],
      [p("da-hye", "多惠")]
    );
    expect(out).toBe("多惠登場");
  });

  it("skips single-character old translations to avoid false hits", () => {
    const out = alignPlotSummaryWithGlossary(
      "雨傘下的傘兵",
      [{ term: "Umbrella", translation: "傘", category: "term" as const }],
      [{ term: "Umbrella", translation: "雨具", category: "term" as const }]
    );
    expect(out).toBe("雨傘下的傘兵");
  });

  it("returns the summary unchanged when nothing differs", () => {
    const summary = "白賢祐與洪海仁";
    const out = alignPlotSummaryWithGlossary(
      summary,
      [p("Baek Hyun-woo", "白賢祐")],
      [p("Baek Hyun-woo", "白賢祐"), p("Hyein", "海仁")]
    );
    expect(out).toBe(summary);
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

  it("injects only the series glossary entries that appear in each section", async () => {
    const neo = { term: "Neo", translation: "尼歐", category: "person" as const };
    const trinity = { term: "Trinity", translation: "崔妮蒂", category: "person" as const };
    await getOrCreateAnalysis({
      texts: ["Neo wakes up", "Trinity calls", "nobody here"], cacheFile: tmpCacheFile(),
      contentHash: "h", forceReanalyze: false, params: PARAMS, existingGlossary: [neo, trinity],
    });
    const injected = vi.mocked(translate.analyzeSubtitlesForContext).mock.calls.map(
      (call) => call[1].existingGlossary
    );
    expect(injected).toEqual([[neo], [trinity], []]);
  });

  it("reports partial section failures and logs the raw response", async () => {
    const cacheFile = tmpCacheFile();
    vi.mocked(translate.analyzeSubtitlesForContext)
      .mockResolvedValueOnce({ plotSummary: "p1", glossary: [] })
      .mockRejectedValueOnce(
        Object.assign(new Error("No JSON value found"), { text: "[1.0]" })
      )
      .mockResolvedValueOnce({ plotSummary: "p3", glossary: [] });
    const onSectionFailures = vi.fn();
    const r = await getOrCreateAnalysis({
      texts: ["a", "b", "c"], cacheFile, contentHash: "h",
      forceReanalyze: true, params: PARAMS, onSectionFailures,
    });
    expect(r).not.toBeNull();
    expect(onSectionFailures).toHaveBeenCalledWith(1, 3);
    const log = fs.readFileSync(cacheFile.replace(".analysis.json", ".analysis-failures.log"), "utf8");
    expect(log).toContain("analysis section 2/3");
    expect(log).toContain("[1.0]");
  });

  it("does not report failures when every section succeeds", async () => {
    const onSectionFailures = vi.fn();
    await getOrCreateAnalysis({
      texts: ["a", "b", "c"], cacheFile: tmpCacheFile(), contentHash: "h",
      forceReanalyze: true, params: PARAMS, onSectionFailures,
    });
    expect(onSectionFailures).not.toHaveBeenCalled();
  });
});

describe("filterGlossaryForText", () => {
  const g = (term: string, category: any = "person") => ({
    term,
    translation: `譯${term}`,
    category,
  });

  it("keeps only terms that appear in the texts, preserving order", () => {
    const result = filterGlossaryForText(
      [g("Neo"), g("Trinity"), g("Morpheus")],
      ["Neo talks to Trinity.", "another line"]
    );
    expect(result.map((x) => x.term)).toEqual(["Neo", "Trinity"]);
  });

  it("matches case-insensitively", () => {
    expect(filterGlossaryForText([g("Neo")], ["NEO!"])).toHaveLength(1);
  });

  it("does not match inside longer words (Bae vs Baek)", () => {
    expect(filterGlossaryForText([g("Bae")], ["Baek Hyun-woo appears"])).toEqual([]);
  });

  it("matches inflected forms separated by non-word characters", () => {
    expect(filterGlossaryForText([g("Hyunwoo")], ["Hyunwoo's plan"])).toHaveLength(1);
    expect(filterGlossaryForText([g("Hyein")], ["Hyein-ah, come here"])).toHaveLength(1);
  });

  it("matches CJK terms by substring", () => {
    expect(
      filterGlossaryForText([g("女王集團", "organization")], ["歡迎來到女王集團總部"])
    ).toHaveLength(1);
  });

  it("escapes regex special characters inside terms", () => {
    // 未 escape 時 'Mr. Kim' 的 '.' 會誤中 'Mrs Kim'
    expect(filterGlossaryForText([g("Mr. Kim")], ["Mrs Kim arrived"])).toEqual([]);
    expect(filterGlossaryForText([g("Mr. Kim")], ["Mr. Kim arrived"])).toHaveLength(1);
    // 首尾非英數的 term 走 substring，特殊字元不得炸掉
    expect(
      filterGlossaryForText([g("J Hotel (Seoul)", "place")], ["at J Hotel (Seoul) tonight"])
    ).toHaveLength(1);
  });

  it("returns empty for empty glossary or blank texts", () => {
    expect(filterGlossaryForText([], ["Neo"])).toEqual([]);
    expect(filterGlossaryForText([g("Neo")], ["", "  "])).toEqual([]);
  });

  it("matches hyphenation variants in both directions", () => {
    // term 無連字號、原文有：實測回歸案例（Hye-in → Hyein）
    expect(
      filterGlossaryForText([g("Hyein")], ["only Baek Seobang knows that Hye-in is sick"])
    ).toHaveLength(1);
    // term 有連字號、原文無
    expect(
      filterGlossaryForText([g("Baek Hyun-woo")], ["Baek Hyunwoo appears"])
    ).toHaveLength(1);
  });

  it("hyphen normalization does not weaken boundary protection", () => {
    expect(filterGlossaryForText([g("Bae")], ["Baek Hyun-woo appears"])).toEqual([]);
  });
});
