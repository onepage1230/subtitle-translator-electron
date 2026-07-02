import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../electron/main/utils/translate", () => ({
  translateSubtitleChunk: vi.fn(),
  translateSubtitleSingle: vi.fn(),
  analyzeSubtitlesForContext: vi.fn(),
  synthesizePlotSummaries: vi.fn(),
}));

import { translateFile } from "../../electron/main/utils/pipeline";
import { loadSeriesGlossary, SERIES_GLOSSARY_FILE } from "../../electron/main/utils/seriesGlossary";
import * as translate from "../../electron/main/utils/translate";

const SRT_EP = (line: string) => `1
00:00:01,000 --> 00:00:02,000
${line}
`;

const BASE_PARAMS = {
  apiKeys: ["k"], apiHost: "https://h/v1", model: "m",
  prompt: "p {{lang}} {{additional}}", lang: "zh-TW", additional: "", temperature: 1,
};

beforeEach(() => {
  vi.mocked(translate.translateSubtitleChunk).mockReset()
    .mockImplementation(async (subs: string[]) => subs.map((s) => `T:${s}`));
  vi.mocked(translate.translateSubtitleSingle).mockReset()
    .mockImplementation(async (s: string) => `T:${s}`);
  vi.mocked(translate.synthesizePlotSummaries).mockReset().mockResolvedValue("synth");
});

it("episode 2 analysis receives episode 1 glossary; series file accumulates", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "stx-series-"));
  const ep1 = path.join(folder, "EP1.srt");
  const ep2 = path.join(folder, "EP2.srt");
  fs.writeFileSync(ep1, SRT_EP("Neo appears"), "utf8");
  fs.writeFileSync(ep2, SRT_EP("Trinity appears"), "utf8");

  vi.mocked(translate.analyzeSubtitlesForContext).mockReset()
    .mockImplementation(async (subs: string[]) => ({
      plotSummary: "p",
      glossary: subs.join(" ").includes("Neo")
        ? [{ term: "Neo", translation: "尼歐", category: "person" as const }]
        : [{ term: "Trinity", translation: "崔妮蒂", category: "person" as const }],
    }));

  await translateFile({ path: ep1, name: "EP1.srt" }, BASE_PARAMS, () => {});

  // EP1 後：series glossary 已含 Neo
  expect(loadSeriesGlossary(folder).map((t) => t.term)).toEqual(["Neo"]);

  await translateFile({ path: ep2, name: "EP2.srt" }, BASE_PARAMS, () => {});

  // EP2 的分析收到了 EP1 的詞彙
  const ep2Calls = vi.mocked(translate.analyzeSubtitlesForContext).mock.calls
    .filter(([subs]) => subs.join(" ").includes("Trinity"));
  expect(ep2Calls.length).toBeGreaterThan(0);
  for (const call of ep2Calls) {
    expect(call[1].existingGlossary!.map((g: any) => g.term)).toContain("Neo");
  }

  // series glossary 累積兩集詞彙
  const terms = loadSeriesGlossary(folder).map((t) => t.term).sort();
  expect(terms).toEqual(["Neo", "Trinity"]);
});
