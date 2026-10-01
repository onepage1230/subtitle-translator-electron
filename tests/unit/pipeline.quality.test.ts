// 品質檢查整合測試：mock 佈置同 pipeline.retry.test.ts
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
`;
const PARAMS = {
  apiKeys: ["k"], apiHost: "https://h/v1", model: "m",
  prompt: "p", lang: "繁體中文", additional: "", temperature: 1,
};

beforeEach(() => {
  vi.mocked(translate.analyzeSubtitlesForContext).mockReset().mockResolvedValue({
    plotSummary: "p", glossary: [],
  } as any);
  vi.mocked(translate.synthesizePlotSummaries).mockReset().mockResolvedValue("synth");
  vi.mocked(translate.translateSubtitleChunk).mockReset()
    .mockResolvedValue(["这是你好", "世界"] as any);
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stx-quality-"));
  const file = path.join(dir, "movie.srt");
  fs.writeFileSync(file, SRT, "utf8");
  return { file, out: file.replace(/\.srt$/, ".translated.srt") };
}

describe("pipeline quality check", () => {
  it("retranslates a line containing simplified chars and uses the new translation", async () => {
    const { file, out } = setup();
    vi.mocked(translate.translateSubtitleSingle).mockReset().mockResolvedValue("你好" as any);
    const events: any[] = [];
    await translateFile({ path: file, name: "movie.srt" }, PARAMS, (e) => events.push(e));
    const last = events[events.length - 1];
    expect(translate.translateSubtitleSingle).toHaveBeenCalledTimes(1);
    expect(last.qualityFlagged).toBe(1);
    expect(last.failedCues).toBe(0);
    const text = fs.readFileSync(out, "utf8");
    expect(text).toContain("你好");
    expect(text).not.toContain("这是你好");
    expect(events.every((e) => e.progress <= 100)).toBe(true);
  });

  it("keeps the original translation and does not count as failed when retranslation fails", async () => {
    const { file, out } = setup();
    vi.mocked(translate.translateSubtitleSingle).mockReset().mockRejectedValue(new Error("bad"));
    const events: any[] = [];
    await translateFile({ path: file, name: "movie.srt" }, PARAMS, (e) => events.push(e));
    const last = events[events.length - 1];
    expect(last.failedCues).toBe(0);
    expect(last.failedKeys).toEqual([]);
    const text = fs.readFileSync(out, "utf8");
    expect(text).toContain("这是你好");
    expect(text).not.toContain("__FAILED__");
  });
});
