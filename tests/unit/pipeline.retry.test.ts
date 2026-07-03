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

it("retranslates everything when the existing output is already complete", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stx-redo-"));
  const file = path.join(dir, "movie.srt");
  fs.writeFileSync(file, SRT, "utf8");

  // 第一輪：全部成功
  vi.mocked(translate.translateSubtitleChunk).mockReset()
    .mockImplementation(async (subs: string[]) => subs.map((s) => `T:${s}`));
  vi.mocked(translate.translateSubtitleSingle).mockReset()
    .mockImplementation(async (s: string) => `T:${s}`);

  await translateFile({ path: file, name: "movie.srt" }, BASE_PARAMS, () => {});
  const outPath = file.replace(/\.srt$/, ".translated.srt");
  expect(fs.readFileSync(outPath, "utf8")).toContain("T:Hello");

  // 第二輪：對已完成的檔案再次按下翻譯 = 重做（例如套用編輯後的詞彙表），
  // 不得因 resume 預填而變成 no-op
  vi.mocked(translate.translateSubtitleChunk).mockReset()
    .mockImplementation(async (subs: string[]) => subs.map((s) => `R:${s}`));
  vi.mocked(translate.translateSubtitleSingle).mockReset()
    .mockImplementation(async (s: string) => `R:${s}`);

  const events: any[] = [];
  await translateFile({ path: file, name: "movie.srt" }, BASE_PARAMS, (e) =>
    events.push(e)
  );

  expect(events[events.length - 1].status).toBe("done");
  const out = fs.readFileSync(outPath, "utf8");
  expect(out).toContain("R:Hello");
  expect(out).toContain("R:World");
  expect(out).toContain("R:Again");
  expect(out).not.toContain("T:Hello");
});
