import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../electron/main/utils/translate", () => ({
  translateSubtitleChunk: vi.fn(),
  translateSubtitleSingle: vi.fn(),
  analyzeSubtitlesForContext: vi.fn(),
  synthesizePlotSummaries: vi.fn(),
  reconcileGlossary: vi.fn(),
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
  // 預設調和為 no-op（回傳輸入），個別測試再覆寫
  vi.mocked(translate.reconcileGlossary).mockReset()
    .mockImplementation(async (entries: any[]) => entries);
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
  expect(loadSeriesGlossary(folder).terms.map((t) => t.term)).toEqual(["Neo"]);

  await translateFile({ path: ep2, name: "EP2.srt" }, BASE_PARAMS, () => {});

  // EP2 的分析收到了 EP1 的詞彙
  const ep2Calls = vi.mocked(translate.analyzeSubtitlesForContext).mock.calls
    .filter(([subs]) => subs.join(" ").includes("Trinity"));
  expect(ep2Calls.length).toBeGreaterThan(0);
  for (const call of ep2Calls) {
    expect(call[1].existingGlossary!.map((g: any) => g.term)).toContain("Neo");
  }

  // series glossary 累積兩集詞彙
  const terms = loadSeriesGlossary(folder).terms.map((t) => t.term).sort();
  expect(terms).toEqual(["Neo", "Trinity"]);
});

it("reconciliation aligns romanization variants across episodes", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "stx-series-"));
  const ep1 = path.join(folder, "EP1.srt");
  const ep2 = path.join(folder, "EP2.srt");
  fs.writeFileSync(ep1, SRT_EP("Baek Hyeon-woo appears"), "utf8");
  fs.writeFileSync(ep2, SRT_EP("Baek Hyun-woo appears"), "utf8");

  vi.mocked(translate.analyzeSubtitlesForContext).mockReset()
    .mockImplementation(async (subs: string[]) => ({
      plotSummary: "p",
      glossary: subs.join(" ").includes("Hyeon-woo")
        ? [{ term: "Baek Hyeon-woo", translation: "白賢祐", category: "person" as const }]
        : [{ term: "Baek Hyun-woo", translation: "白賢宇", category: "person" as const }],
    }));
  // 模型調和：認出變體，改用既有譯名
  vi.mocked(translate.reconcileGlossary).mockReset()
    .mockImplementation(async (entries: any[], locked: any[]) =>
      entries.map((e: any) =>
        e.term === "Baek Hyun-woo" ? { ...e, translation: "白賢祐" } : e
      )
    );

  await translateFile({ path: ep1, name: "EP1.srt" }, BASE_PARAMS, () => {});
  // EP1 只有一個 person 且無既有詞彙 → 不需調和
  expect(translate.reconcileGlossary).not.toHaveBeenCalled();

  await translateFile({ path: ep2, name: "EP2.srt" }, BASE_PARAMS, () => {});

  // EP2 觸發調和：收到本集新詞彙與 LOCKED 的 series 詞彙
  expect(translate.reconcileGlossary).toHaveBeenCalledTimes(1);
  const [newEntries, lockedEntries] = vi.mocked(translate.reconcileGlossary).mock.calls[0];
  expect(newEntries.map((e: any) => e.term)).toContain("Baek Hyun-woo");
  expect(lockedEntries.map((e: any) => e.term)).toContain("Baek Hyeon-woo");

  // 兩種拼法在 series glossary 中共用同一譯名
  const glossary = loadSeriesGlossary(folder).terms;
  const byTerm = Object.fromEntries(glossary.map((g) => [g.term, g.translation]));
  expect(byTerm["Baek Hyeon-woo"]).toBe("白賢祐");
  expect(byTerm["Baek Hyun-woo"]).toBe("白賢祐");
});

it("falls back to the raw glossary when reconciliation fails", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "stx-series-"));
  const ep1 = path.join(folder, "EP1.srt");
  fs.writeFileSync(ep1, SRT_EP("Two people appear"), "utf8");

  vi.mocked(translate.analyzeSubtitlesForContext).mockReset().mockResolvedValue({
    plotSummary: "p",
    glossary: [
      { term: "Hong Hye-in", translation: "洪惠仁", category: "person" as const },
      { term: "Hyein", translation: "惠仁", category: "person" as const },
    ],
  } as any);
  vi.mocked(translate.reconcileGlossary).mockReset()
    .mockRejectedValue(new Error("reconcile down"));

  const events: any[] = [];
  await translateFile({ path: ep1, name: "EP1.srt" }, BASE_PARAMS, (e) =>
    events.push(e)
  );

  // 調和失敗不阻斷：翻譯完成，原始詞彙表照常寫入
  expect(events[events.length - 1].status).toBe("done");
  const terms = loadSeriesGlossary(folder).terms.map((t) => t.term).sort();
  expect(terms).toEqual(["Hong Hye-in", "Hyein"]);
});
