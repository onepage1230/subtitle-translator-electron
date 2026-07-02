import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSeriesGlossary,
  mergeIntoSeriesGlossary,
  saveSeriesGlossary,
  enforceReconciliation,
  SERIES_GLOSSARY_FILE,
  SERIES_GLOSSARY_CAP,
} from "../../electron/main/utils/seriesGlossary";

const e = (term: string, category: any = "term") => ({
  term,
  translation: `譯${term}`,
  category,
});

function tmpFolder(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stx-"));
}

describe("mergeIntoSeriesGlossary", () => {
  it("first wins, case-insensitive", () => {
    const merged = mergeIntoSeriesGlossary([e("Neo")], [e("neo"), e("Trinity")]);
    expect(merged.map((x) => x.term)).toEqual(["Neo", "Trinity"]);
  });

  it("rejects entries with invalid category", () => {
    const merged = mergeIntoSeriesGlossary([], [e("Neo", "person"), e("run", "verb")]);
    expect(merged.map((x) => x.term)).toEqual(["Neo"]);
  });

  it("caps at 100 with category priority person > organization > place > term", () => {
    const terms = [
      ...Array.from({ length: 40 }, (_, i) => e(`term${i}`, "term")),
      ...Array.from({ length: 30 }, (_, i) => e(`place${i}`, "place")),
      ...Array.from({ length: 20 }, (_, i) => e(`org${i}`, "organization")),
      ...Array.from({ length: 20 }, (_, i) => e(`person${i}`, "person")),
    ]; // 110 條
    const merged = mergeIntoSeriesGlossary([], terms);
    expect(merged).toHaveLength(SERIES_GLOSSARY_CAP);
    // 全部 person/organization/place（70 條）存活，term 被裁至 30 條
    expect(merged.filter((x) => x.category === "person")).toHaveLength(20);
    expect(merged.filter((x) => x.category === "organization")).toHaveLength(20);
    expect(merged.filter((x) => x.category === "place")).toHaveLength(30);
    expect(merged.filter((x) => x.category === "term")).toHaveLength(30);
    // term 之中先到者存活
    expect(merged.some((x) => x.term === "term0")).toBe(true);
    expect(merged.some((x) => x.term === "term39")).toBe(false);
  });
});

describe("load/save", () => {
  it("round-trips through the folder file", () => {
    const folder = tmpFolder();
    saveSeriesGlossary(folder, [e("Neo", "person")]);
    expect(fs.existsSync(path.join(folder, SERIES_GLOSSARY_FILE))).toBe(true);
    expect(loadSeriesGlossary(folder)).toEqual([e("Neo", "person")]);
  });

  it("returns [] for missing or corrupted file", () => {
    const folder = tmpFolder();
    expect(loadSeriesGlossary(folder)).toEqual([]);
    fs.writeFileSync(path.join(folder, SERIES_GLOSSARY_FILE), "{oops");
    expect(loadSeriesGlossary(folder)).toEqual([]);
  });

  it("fills missing category as 'term' when loading legacy entries", () => {
    const folder = tmpFolder();
    fs.writeFileSync(
      path.join(folder, SERIES_GLOSSARY_FILE),
      JSON.stringify({ terms: [{ term: "Neo", translation: "尼歐" }] })
    );
    expect(loadSeriesGlossary(folder)[0].category).toBe("term");
  });
});

describe("enforceReconciliation", () => {
  const p = (term: string, translation: string) => ({
    term,
    translation,
    category: "person" as const,
  });

  it("restores locked translations the model tried to change", () => {
    const locked = [p("Baek Hyeon-woo", "白賢祐")];
    const originals = [p("Baek Hyun-woo", "白賢宇")];
    const reconciled = [
      p("Baek Hyeon-woo", "白某某"), // 模型違規改了 LOCKED
      p("Baek Hyun-woo", "白賢祐"), // 模型正確調和了變體
    ];
    const result = enforceReconciliation(reconciled, originals, locked);
    expect(result).toContainEqual(p("Baek Hyeon-woo", "白賢祐"));
    expect(result).toContainEqual(p("Baek Hyun-woo", "白賢祐"));
  });

  it("re-adds entries the model dropped", () => {
    const originals = [p("Hong Hye-in", "洪惠仁"), p("Hyein", "惠仁")];
    const reconciled = [p("Hong Hye-in", "洪惠仁")]; // 模型漏了 Hyein
    const result = enforceReconciliation(reconciled, originals, []);
    expect(result).toContainEqual(p("Hyein", "惠仁"));
    expect(result).toHaveLength(2);
  });

  it("drops entries the model invented", () => {
    const originals = [p("Neo", "尼歐")];
    const reconciled = [p("Neo", "尼歐"), p("Morpheus", "莫菲斯")]; // 憑空多了一條
    const result = enforceReconciliation(reconciled, originals, []);
    expect(result.map((e) => e.term)).toEqual(["Neo"]);
  });

  it("keeps model corrections on new entries and dedupes case-insensitively", () => {
    const locked = [p("Hong Hye-in", "洪惠仁")];
    const originals = [p("hyein", "海仁")];
    const reconciled = [
      p("Hong Hye-in", "洪惠仁"),
      p("hyein", "惠仁"),
      p("Hyein", "惠仁"), // 大小寫重複
    ];
    const result = enforceReconciliation(reconciled, originals, locked);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual(p("hyein", "惠仁"));
  });
});
