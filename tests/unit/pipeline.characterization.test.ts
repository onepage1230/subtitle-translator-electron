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
