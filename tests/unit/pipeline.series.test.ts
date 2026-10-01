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

it("episode 2 analysis receives the episode 1 terms it mentions; series file accumulates", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "stx-series-"));
  const ep1 = path.join(folder, "EP1.srt");
  const ep2 = path.join(folder, "EP2.srt");
  fs.writeFileSync(ep1, SRT_EP("Neo appears"), "utf8");
  // 分析只注入本段出現過的劇集詞條，所以 EP2 要提到 Neo 才會收到
  fs.writeFileSync(ep2, SRT_EP("Trinity meets Neo"), "utf8");

  vi.mocked(translate.analyzeSubtitlesForContext).mockReset()
    .mockImplementation(async (subs: string[]) => ({
      plotSummary: "p",
      glossary: !subs.join(" ").includes("Trinity")
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

// 段落分析需要推理人物關係（關閉 thinking 時 E02 摘要錯置人物），調和與合成不需要
describe("analysisThinkingMode", () => {
  const SRT_3 = `1
00:00:01,000 --> 00:00:02,000
Neo and Trinity

2
00:00:03,000 --> 00:00:04,000
Neo again

3
00:00:05,000 --> 00:00:06,000
Trinity again
`;
  const run = async (mode?: "keep" | "light" | "off") => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "stx-think-"));
    const file = path.join(folder, "EP1.srt");
    fs.writeFileSync(file, SRT_3, "utf8");
    vi.mocked(translate.analyzeSubtitlesForContext).mockReset().mockResolvedValue({
      plotSummary: "p",
      glossary: [
        { term: "Neo", translation: "尼歐", category: "person" },
        { term: "Trinity", translation: "崔妮蒂", category: "person" },
      ],
    });
    await translateFile(
      { path: file, name: "EP1.srt" },
      { ...BASE_PARAMS, analysisThinkingMode: mode },
      () => {}
    );
    return {
      section: vi.mocked(translate.analyzeSubtitlesForContext).mock.calls[0][1].disableThinking,
      synth: vi.mocked(translate.synthesizePlotSummaries).mock.calls[0][1].disableThinking,
      reconcile: vi.mocked(translate.reconcileGlossary).mock.calls[0][2].disableThinking,
    };
  };

  it("light (default) keeps thinking only for section analysis", async () => {
    expect(await run(undefined)).toEqual({ section: false, synth: true, reconcile: true });
    expect(await run("light")).toEqual({ section: false, synth: true, reconcile: true });
  });
  it("keep never disables thinking", async () => {
    expect(await run("keep")).toEqual({ section: false, synth: false, reconcile: false });
  });
  it("off disables thinking everywhere", async () => {
    expect(await run("off")).toEqual({ section: true, synth: true, reconcile: true });
  });
});
