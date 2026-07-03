import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSeriesGlossary,
  mergeIntoSeriesGlossary,
  saveSeriesGlossary,
  enforceReconciliation,
  editGlossaryTranslation,
  deleteGlossaryTerm,
  applyGlossaryOp,
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
    expect(loadSeriesGlossary(folder)).toEqual({
      terms: [e("Neo", "person")],
      excluded: [],
    });
  });

  it("returns empty data for missing or corrupted file", () => {
    const folder = tmpFolder();
    expect(loadSeriesGlossary(folder)).toEqual({ terms: [], excluded: [] });
    fs.writeFileSync(path.join(folder, SERIES_GLOSSARY_FILE), "{oops");
    expect(loadSeriesGlossary(folder)).toEqual({ terms: [], excluded: [] });
  });

  it("fills missing category as 'term' when loading legacy entries", () => {
    const folder = tmpFolder();
    fs.writeFileSync(
      path.join(folder, SERIES_GLOSSARY_FILE),
      JSON.stringify({ terms: [{ term: "Neo", translation: "尼歐" }] })
    );
    expect(loadSeriesGlossary(folder).terms[0].category).toBe("term");
  });
});

describe("excluded list", () => {
  it("merge skips excluded terms case-insensitively", () => {
    const merged = mergeIntoSeriesGlossary(
      [e("Neo")],
      [e("Trinity"), e("Morpheus")],
      ["trinity", "neo"]
    );
    expect(merged.map((x) => x.term)).toEqual(["Morpheus"]);
  });

  it("merge without excluded param behaves as before", () => {
    const merged = mergeIntoSeriesGlossary([e("Neo")], [e("neo"), e("Trinity")]);
    expect(merged.map((x) => x.term)).toEqual(["Neo", "Trinity"]);
  });

  it("round-trips excluded through save/load", () => {
    const folder = tmpFolder();
    saveSeriesGlossary(folder, [e("Neo", "person")], ["trinity"]);
    expect(loadSeriesGlossary(folder)).toEqual({
      terms: [e("Neo", "person")],
      excluded: ["trinity"],
    });
  });

  it("legacy file without excluded field loads as empty excluded", () => {
    const folder = tmpFolder();
    fs.writeFileSync(
      path.join(folder, SERIES_GLOSSARY_FILE),
      JSON.stringify({ terms: [e("Neo", "person")] })
    );
    expect(loadSeriesGlossary(folder).excluded).toEqual([]);
  });

  it("save returns true on success and false on failure", () => {
    const folder = tmpFolder();
    expect(saveSeriesGlossary(folder, [e("Neo", "person")])).toBe(true);
    expect(
      saveSeriesGlossary(path.join(folder, "no-such-dir"), [e("Neo", "person")])
    ).toBe(false);
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

describe("editGlossaryTranslation", () => {
  const data = () => ({
    terms: [{ term: "Baek Hyun-woo", translation: "白賢宇", category: "person" as const }],
    excluded: [] as string[],
  });

  it("updates translation and marks userEdited", () => {
    const next = editGlossaryTranslation(data(), "Baek Hyun-woo", "白賢祐");
    expect(next.terms[0]).toEqual({
      term: "Baek Hyun-woo",
      translation: "白賢祐",
      category: "person",
      userEdited: true,
    });
  });

  it("matches term case-insensitively", () => {
    const next = editGlossaryTranslation(data(), "baek hyun-woo", "白賢祐");
    expect(next.terms[0].translation).toBe("白賢祐");
  });

  it("returns same object when translation is blank", () => {
    const d = data();
    expect(editGlossaryTranslation(d, "Baek Hyun-woo", "   ")).toBe(d);
  });

  it("returns same object when term not found", () => {
    const d = data();
    expect(editGlossaryTranslation(d, "Nobody", "誰")).toBe(d);
  });

  it("trims the new translation", () => {
    const next = editGlossaryTranslation(data(), "Baek Hyun-woo", " 白賢祐 ");
    expect(next.terms[0].translation).toBe("白賢祐");
  });
});

describe("deleteGlossaryTerm", () => {
  it("removes the entry and records lowercase term in excluded", () => {
    const next = deleteGlossaryTerm(
      { terms: [e("Neo", "person"), e("Trinity", "person")], excluded: [] },
      "Neo"
    );
    expect(next.terms.map((x) => x.term)).toEqual(["Trinity"]);
    expect(next.excluded).toEqual(["neo"]);
  });

  it("is a no-op on repeated delete", () => {
    const once = deleteGlossaryTerm({ terms: [e("Neo")], excluded: [] }, "Neo");
    const twice = deleteGlossaryTerm(once, "neo");
    expect(twice.terms).toEqual([]);
    expect(twice.excluded).toEqual(["neo"]);
  });
});

describe("applyGlossaryOp", () => {
  it("edit op persists to the folder file", () => {
    const folder = tmpFolder();
    saveSeriesGlossary(folder, [{ ...e("Neo", "person"), translation: "尼奧" }]);
    const { terms } = applyGlossaryOp(folder, {
      type: "edit",
      term: "Neo",
      translation: "尼歐",
    });
    expect(terms[0].translation).toBe("尼歐");
    expect(loadSeriesGlossary(folder).terms[0]).toMatchObject({
      translation: "尼歐",
      userEdited: true,
    });
  });

  it("delete op persists terms and excluded", () => {
    const folder = tmpFolder();
    saveSeriesGlossary(folder, [e("Neo", "person")]);
    const { terms } = applyGlossaryOp(folder, { type: "delete", term: "Neo" });
    expect(terms).toEqual([]);
    expect(loadSeriesGlossary(folder).excluded).toEqual(["neo"]);
  });

  it("no-op edit does not rewrite the file", () => {
    const folder = tmpFolder();
    saveSeriesGlossary(folder, [e("Neo", "person")]);
    const before = fs.statSync(path.join(folder, SERIES_GLOSSARY_FILE)).mtimeMs;
    applyGlossaryOp(folder, { type: "edit", term: "Nobody", translation: "誰" });
    const after = fs.statSync(path.join(folder, SERIES_GLOSSARY_FILE)).mtimeMs;
    expect(after).toBe(before);
  });

  it("throws when the folder is not writable", () => {
    const folder = tmpFolder();
    saveSeriesGlossary(folder, [e("Neo", "person")]);
    // 在 macOS 上，writeFileSync 可以覆寫已存在的檔案即使資料夾是唯讀
    // 所以先刪檔再設 chmod，確保新寫入會失敗
    fs.unlinkSync(path.join(folder, SERIES_GLOSSARY_FILE));
    fs.chmodSync(folder, 0o500); // 唯讀資料夾
    try {
      expect(() =>
        applyGlossaryOp(folder, { type: "delete", term: "Neo" })
      ).toThrow("Failed to write series glossary");
    } finally {
      fs.chmodSync(folder, 0o700);
    }
  });
});
