import { describe, it, expect, vi } from "vitest";
import {
  findCandidatePairs,
  translationsConsistent,
  linesMentioning,
  planReconciliation,
} from "../../electron/main/utils/nameMatch";

const p = (term: string, translation: string) => ({ term, translation, category: "person" as const });
const names = (pairs: any[]) => pairs.map((x) => `${x.a.term}|${x.b.term}`);

describe("findCandidatePairs", () => {
  it("pairs given name with full name, romanization variants, and shared translation chars", () => {
    const pairs = findCandidatePairs(
      [p("Jae Ha", "載河"), p("So Ho", "秀浩")],
      [p("Yoon Jae-Ha", "尹在夏"), p("Su-Ho", "秀浩"), p("Phillip", "菲利普")]
    );
    expect(names(pairs)).toContain("Jae Ha|Yoon Jae-Ha"); // subset
    expect(names(pairs)).toContain("So Ho|Su-Ho"); // spelling + shared char
    expect(names(pairs).some((n) => n.includes("Phillip"))).toBe(false);
  });
  it("ignores non-person entries and locked-locked pairs", () => {
    const pairs = findCandidatePairs(
      [{ term: "Seoul", translation: "首爾", category: "place" as const }],
      [p("Jae-Ha", "在夏"), p("Yoon Jae-Ha", "尹在夏")]
    );
    expect(pairs).toEqual([]);
  });
});

describe("translationsConsistent", () => {
  it("accepts equal or contained translations", () => {
    expect(translationsConsistent("在夏", "尹在夏")).toBe(true);
    expect(translationsConsistent("秀浩", "秀浩")).toBe(true);
    expect(translationsConsistent("載河", "在夏")).toBe(false);
  });
});

describe("linesMentioning", () => {
  it("matches hyphen/space variants on word boundaries", () => {
    const texts = ["Isn't that Jae Ha?", "Jae-Ha knows", "Jaehan is here"];
    expect(linesMentioning("Jae-Ha", texts)).toEqual(["Isn't that Jae Ha?", "Jae-Ha knows"]);
  });
});

describe("planReconciliation", () => {
  const texts = ["Jae Ha is here", "Isn't that Jae Ha?", "Yoon Jae-Ha plays piano", "I love Yoon Jae-Ha"];
  const jev = (score: number) => {
    const f = vi.fn(async (_u: any, init: any) => {
      const body = JSON.parse(init.body);
      const answers: any = {};
      Object.keys(body.questions).forEach((k) => (answers[k] = { noul: score }));
      return { ok: true, status: 200, json: async () => ({ answers }) } as any;
    });
    return f;
  };

  it("reconciles with a hint when Jev confirms an inconsistent same-person pair", async () => {
    const f = jev(0.97);
    const plan = await planReconciliation([p("Jae Ha", "載河")], [p("Yoon Jae-Ha", "尹在夏")], texts, "K", { fetchImpl: f as any });
    expect(plan).toEqual({ reconcile: true, hints: [["Jae Ha", "Yoon Jae-Ha"]] });
  });

  it("skips reconciliation when Jev says they are different people", async () => {
    const plan = await planReconciliation([p("Jae Ha", "載河")], [p("Yoon Jae-Ha", "尹在夏")], texts, "K", { fetchImpl: jev(0.1) as any });
    expect(plan).toEqual({ reconcile: false, hints: [] });
  });

  it("skips Jev and reconciliation when translations are already consistent", async () => {
    const f = jev(0.97);
    const plan = await planReconciliation([p("Jae Ha", "在夏")], [p("Yoon Jae-Ha", "尹在夏")], texts, "K", { fetchImpl: f as any });
    expect(plan).toEqual({ reconcile: false, hints: [] });
    expect(f).not.toHaveBeenCalled();
  });

  it("reconciles without asking Jev when a name has too few lines", async () => {
    const f = jev(0.1);
    const plan = await planReconciliation([p("So Ho", "小浩")], [p("Su-Ho", "秀浩")], ["So Ho!"], "K", { fetchImpl: f as any });
    expect(plan.reconcile).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it("throws when Jev fails so the caller can fall back", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as any);
    await expect(
      planReconciliation([p("Jae Ha", "載河")], [p("Yoon Jae-Ha", "尹在夏")], texts, "K", { fetchImpl: f as any })
    ).rejects.toThrow("HTTP 500");
  });
});
