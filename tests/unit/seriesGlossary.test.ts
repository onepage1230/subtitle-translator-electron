import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSeriesGlossary,
  mergeIntoSeriesGlossary,
  saveSeriesGlossary,
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
