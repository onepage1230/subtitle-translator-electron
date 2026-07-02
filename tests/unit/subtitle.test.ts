import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseSubtitle,
  saveTranslated,
  splitIntoChunk,
  normalizeCues,
} from "../../electron/main/utils/subtitle";

const SRT = `1
00:00:01,000 --> 00:00:02,000
Hello

2
00:00:03,000 --> 00:00:04,000
World
`;

const ASS = `[Script Info]
Title: test

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello
Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,World
`;

function tmpFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stx-")), name);
}

describe("normalizeCues", () => {
  it("filters cue lines from srt/vtt array shape", () => {
    const cues = normalizeCues(parseSubtitle(SRT, "srt"));
    expect(cues).toHaveLength(2);
    expect(cues[0].data.text).toBe("Hello");
  });
  it("returns events from ass shape", () => {
    const cues = normalizeCues(parseSubtitle(ASS, "ass"));
    expect(cues).toHaveLength(2);
    expect(cues[1].data.text).toBe("World");
  });
  it("passes through an already-flat cue array", () => {
    const flat = [{ type: "cue", data: { text: "x" } }];
    expect(normalizeCues(flat)).toEqual(flat);
  });
});

describe("splitIntoChunk", () => {
  it("splits and skips already-translated cues", () => {
    const cues = [
      { data: { text: "a" } },
      { data: { text: "b", translatedText: "乙" } },
      { data: { text: "c" } },
    ];
    const chunks = splitIntoChunk(cues, 2);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].map((c: any) => c.data.text)).toEqual(["a", "c"]);
  });
});

describe("saveTranslated round-trip", () => {
  it("writes translations for srt and keeps original for __FAILED__", () => {
    const parsed = parseSubtitle(SRT, "srt");
    const cues = normalizeCues(parsed);
    cues[0].data.translatedText = "哈囉";
    cues[1].data.translatedText = "__FAILED__";
    const out = tmpFile("out.srt");
    saveTranslated(out, parsed, "srt", "none");
    const written = fs.readFileSync(out, "utf8");
    expect(written).toContain("哈囉");
    expect(written).not.toContain("__FAILED__");
    expect(written).toContain("World"); // 失敗行寫回原文
  });

  it("writes translations for ass and keeps original for __FAILED__", () => {
    const parsed = parseSubtitle(ASS, "ass");
    const cues = normalizeCues(parsed);
    cues[0].data.translatedText = "哈囉";
    cues[1].data.translatedText = "__FAILED__";
    const out = tmpFile("out.ass");
    saveTranslated(out, parsed, "ass", "none");
    const written = fs.readFileSync(out, "utf8");
    expect(written).toContain("哈囉");
    expect(written).not.toContain("__FAILED__");
    expect(written).toContain("World");
  });

  it("multiLangSave translate+original combines both", () => {
    const parsed = parseSubtitle(SRT, "srt");
    normalizeCues(parsed)[0].data.translatedText = "哈囉";
    const out = tmpFile("out.srt");
    saveTranslated(out, parsed, "srt", "translate+original");
    const written = fs.readFileSync(out, "utf8");
    expect(written).toContain("哈囉\nHello");
  });
});
