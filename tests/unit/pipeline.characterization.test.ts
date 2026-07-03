import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../electron/main/utils/translate", () => {
  return {
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
      glossary: [{ term: "Hello", translation: "哈囉", category: "term" }],
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
});

describe("per-chunk glossary filtering", () => {
  const NUM = 30; // 兩個 chunk：core 0-19（window 0-24）與 core 20-29（window 15-29）

  function makeLongSrt(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stx-filter-"));
    const blocks: string[] = [];
    for (let i = 0; i < NUM; i++) {
      const text =
        i === 0 ? "Neo appears" : i === NUM - 1 ? "Trinity appears" : `filler line ${i}`;
      const s = String(i + 1).padStart(2, "0");
      blocks.push(`${i + 1}\n00:00:${s},000 --> 00:00:${s},500\n${text}`);
    }
    const p = path.join(dir, "long.srt");
    fs.writeFileSync(p, blocks.join("\n\n") + "\n", "utf8");
    return p;
  }

  function mockAnalysisWithTwoTerms() {
    vi.mocked(translate.analyzeSubtitlesForContext).mockReset().mockResolvedValue({
      plotSummary: "part-summary",
      glossary: [
        { term: "Neo", translation: "尼歐", category: "term" },
        { term: "Trinity", translation: "崔妮蒂", category: "place" },
      ],
    } as any);
  }

  it("sends each chunk only the glossary terms present in its window", async () => {
    const file = makeLongSrt();
    mockAnalysisWithTwoTerms();

    await translateFile({ path: file, name: "long.srt" }, BASE_PARAMS, () => {});

    const calls = vi.mocked(translate.translateSubtitleChunk).mock.calls;
    expect(calls).toHaveLength(2);
    const additionals = calls.map((c: any) => c[1].additional as string);
    const withNeo = additionals.find((a) => a.includes("- Neo:"))!;
    const withTrinity = additionals.find((a) => a.includes("- Trinity:"))!;
    expect(withNeo).toBeDefined();
    expect(withTrinity).toBeDefined();
    expect(withNeo).not.toContain("- Trinity:"); // chunk1 視窗（0-24）沒有句 30
    expect(withTrinity).not.toContain("- Neo:"); // chunk2 視窗（15-29）沒有句 1
    // 摘要全量：兩個 chunk 都要有合成後的 plotSummary
    expect(withNeo).toContain("combined-summary");
    expect(withTrinity).toContain("combined-summary");
  });

  it("filters per line in the end-of-file fallback and omits glossary on zero hits", async () => {
    const file = makeLongSrt();
    mockAnalysisWithTwoTerms();
    // 路徑說明：chunk 失敗後句子會先走「視窗內逐行修補」（341），修補也失敗
    // 才會落到檔尾 fallback（444）。讓單行翻譯「每個文字第一次失敗、之後成功」：
    // 修補階段全數失敗，檔尾 fallback 的第二次呼叫成功——對每句而言，
    // 「最後一次」的 translateSubtitleSingle 呼叫即來自檔尾 fallback。
    vi.mocked(translate.translateSubtitleChunk).mockReset()
      .mockRejectedValue(new Error("boom")); // 非網路錯誤 → retryTranslate 不重試
    const seen = new Set<string>();
    vi.mocked(translate.translateSubtitleSingle).mockReset()
      .mockImplementation(async (s: string) => {
        if (!seen.has(s)) {
          seen.add(s);
          throw new Error("first-try boom");
        }
        return `T:${s}`;
      });

    await translateFile({ path: file, name: "long.srt" }, BASE_PARAMS, () => {});

    const calls = vi.mocked(translate.translateSubtitleSingle).mock.calls;
    // 「Neo appears」是句 1，只在 chunk1 視窗內 → 修補失敗一次 + 檔尾一次，
    // 取最後一次呼叫（檔尾 fallback，pipeline.ts:444 路徑）
    const neoCalls = calls.filter((c: any) => c[0] === "Neo appears");
    expect(neoCalls.length).toBeGreaterThanOrEqual(2);
    const lastNeo = neoCalls[neoCalls.length - 1] as any;
    expect(lastNeo[1].additional).toContain("- Neo:");
    expect(lastNeo[1].additional).not.toContain("- Trinity:");
    const fillerCalls = calls.filter((c: any) => c[0] === "filler line 5");
    const lastFiller = fillerCalls[fillerCalls.length - 1] as any;
    expect(lastFiller[1].additional).not.toContain("## Glossary"); // 零命中省略整區
    expect(lastFiller[1].additional).toContain("combined-summary");
  });

  it("filters per line in the window-repair path after misaligned chunks", async () => {
    const file = makeLongSrt();
    mockAnalysisWithTwoTerms();
    // chunk 回傳長度不符 → 視窗內逐行修補（pipeline.ts:341 路徑）
    vi.mocked(translate.translateSubtitleChunk).mockReset()
      .mockImplementation(async () => ["misaligned"]);

    await translateFile({ path: file, name: "long.srt" }, BASE_PARAMS, () => {});

    const calls = vi.mocked(translate.translateSubtitleSingle).mock.calls;
    const neoCall = calls.find((c: any) => c[0] === "Neo appears")!;
    expect(neoCall).toBeDefined();
    expect(neoCall[1].additional).toContain("- Neo:");
    expect(neoCall[1].additional).not.toContain("- Trinity:");
  });
});
