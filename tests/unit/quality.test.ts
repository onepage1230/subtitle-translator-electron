import { describe, it, expect, vi } from "vitest";
import {
  detectCodeIssues,
  isTraditionalChineseTarget,
  isChineseTarget,
  checkWithJev,
  chooseWithJev,
  needsJevChoice,
  pickRetranslation,
} from "../../electron/main/utils/quality";

const T = { traditional: true, chinese: true, glossary: [] as any[] };

describe("detectCodeIssues", () => {
  it("flags simplified chars only when traditional target", () => {
    expect(detectCodeIssues("Hello there", "这是你的时间", T)).toContain("simplified");
    expect(detectCodeIssues("Hello there", "这是你的时间", { ...T, traditional: false })).not.toContain("simplified");
  });
  it("does not flag normal traditional text", () => {
    expect(detectCodeIssues("I have to go back", "我得回去了，皇后說的", T)).toEqual([]);
  });
  it("flags leftover Hangul", () => {
    expect(detectCodeIssues("Thank you", "謝謝 감사합니다", T)).toContain("untranslated");
  });
  it("flags untranslated English", () => {
    expect(detectCodeIssues("Where are you going tonight", "Where are you going tonight", T)).toContain("untranslated");
  });
  it("does not flag interjections / punctuation-only sources", () => {
    expect(detectCodeIssues("...", "...", T)).toEqual([]);
    expect(detectCodeIssues("Oh", "Oh", T)).toEqual([]);
    expect(detectCodeIssues("Hm", "Hm", T)).toEqual([]);
    expect(detectCodeIssues("12:30", "12:30", T)).toEqual([]);
  });
  it("does not flag English with mostly Chinese translation", () => {
    expect(detectCodeIssues("I love you so much", "我非常愛你 so", T)).toEqual([]);
  });
  const g = [
    { term: "Hye-in", translation: "慧仁", category: "person" },
    { term: "Seoul", translation: "首爾", category: "place" },
  ] as any[];
  it("flags person glossary mismatch", () => {
    expect(detectCodeIssues("Hyein is here", "惠恩在這裡", { traditional: true, chinese: true, glossary: g })).toEqual(["glossary:Hye-in"]);
  });
  it("passes when glossary translation matches", () => {
    expect(detectCodeIssues("Hye-in is here", "慧仁在這裡", { traditional: true, chinese: true, glossary: g })).toEqual([]);
  });
  it("ignores non-person glossary entries", () => {
    expect(detectCodeIssues("We are in Seoul", "我們在漢城", { traditional: true, chinese: true, glossary: g })).toEqual([]);
  });
});

describe("isTraditionalChineseTarget", () => {
  it.each([
    ["繁體中文", true], ["Traditional Chinese", true], ["zh-TW", true], ["zh_Hant", true], ["zh-HK", true],
    ["正體中文", true], ["简体中文", false], ["English", false], ["", false], ["zh-CN", false],
  ])("%s -> %s", (lang, expected) => {
    expect(isTraditionalChineseTarget(lang)).toBe(expected);
  });
});

describe("checkWithJev", () => {
  const mkFetch = (noul: (i: number) => number) =>
    vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const answers: any = {};
      Object.keys(body.questions).forEach((k, i) => {
        answers[k] = { type: "noul", noul: noul(i) };
      });
      return { ok: true, status: 200, json: async () => ({ answers }) } as any;
    });
  const pairs = (n: number) => Array.from({ length: n }, (_, i) => ({ source: `s${i}`, translation: `t${i}` }));

  it("sends the expected request shape", async () => {
    const f = mkFetch(() => 0.9);
    await checkWithJev(pairs(2), "KEY", { fetchImpl: f as any });
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer KEY");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("jev-latest");
    expect(body.state.lines).toEqual([{ source: "s0", translation: "t0" }, { source: "s1", translation: "t1" }]);
    expect(Object.keys(body.questions)).toEqual(["l0", "l1"]);
    expect(body.questions.l1.instructions).toContain("lines[1].translation");
  });
  it("applies threshold (p < 0.3 is flagged)", async () => {
    const vals = [0.1, 0.29, 0.3, 0.9];
    const r = await checkWithJev(pairs(4), "K", { fetchImpl: mkFetch((i) => vals[i]) as any });
    expect(r).toEqual([true, true, false, false]);
    const r2 = await checkWithJev(pairs(4), "K", { threshold: 0.5, fetchImpl: mkFetch((i) => vals[i]) as any });
    expect(r2).toEqual([true, true, true, false]);
  });
  it("splits 25 lines into 2 requests and maps results back in order", async () => {
    const f = mkFetch((i) => (i === 0 ? 0.0 : 1));
    const r = await checkWithJev(pairs(25), "K", { fetchImpl: f as any });
    expect(f).toHaveBeenCalledTimes(2);
    expect(r).toHaveLength(25);
    expect(r[0]).toBe(true);
    expect(r[20]).toBe(true); // 第二個 request 的第 0 題
    expect(r.filter(Boolean)).toHaveLength(2);
  });
  it("skips empty and __FAILED__ translations", async () => {
    const f = mkFetch(() => 0);
    const r = await checkWithJev(
      [{ source: "a", translation: "" }, { source: "b", translation: "__FAILED__" }, { source: "c", translation: "x" }],
      "K", { fetchImpl: f as any }
    );
    expect(r).toEqual([false, false, true]);
    expect(JSON.parse((f.mock.calls[0] as any)[1].body).state.lines).toHaveLength(1);
  });
  it("returns all false on fetch failure / non-2xx / missing fields", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const boom = vi.fn(async () => { throw new Error("net"); });
    expect(await checkWithJev(pairs(3), "K", { fetchImpl: boom as any })).toEqual([false, false, false]);
    const non2xx = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    expect(await checkWithJev(pairs(3), "K", { fetchImpl: non2xx as any })).toEqual([false, false, false]);
    const missing = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ answers: {} }) }));
    expect(await checkWithJev(pairs(3), "K", { fetchImpl: missing as any })).toEqual([false, false, false]);
    warn.mockRestore();
  });
});

describe("非中文目標語言", () => {
  const nonZh = { traditional: false, chinese: false, glossary: [] as any[] };
  it("英文、日文、韓文譯文不因中文字比例或 Hangul 被判未翻", () => {
    expect(detectCodeIssues("Where were you last night?", "Où étais-tu hier soir ?", nonZh)).toEqual([]);
    expect(detectCodeIssues("Where were you last night?", "昨夜はどこにいたの？", nonZh)).toEqual([]);
    expect(detectCodeIssues("Where were you last night?", "어젯밤에 어디 있었어?", nonZh)).toEqual([]);
  });
  it("isChineseTarget 辨識中文目標", () => {
    for (const l of ["繁體中文", "简体中文", "Chinese", "zh-TW", "zh", "Traditional Chinese"]) expect(isChineseTarget(l)).toBe(true);
    for (const l of ["English", "日本語", "Japanese", "한국어", "French", ""]) expect(isChineseTarget(l)).toBe(false);
  });
});

describe("chooseWithJev", () => {
  const items = [
    { source: "s0", original: "o0", retranslation: "r0" },
    { source: "s1", original: "o1", retranslation: "r1" },
  ];
  it("sends choice questions over pairs and maps answers", async () => {
    const f = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      expect(body.state.pairs).toEqual(items);
      expect(Object.values(body.questions).every((q: any) => q.type === "choice")).toBe(true);
      expect(Object.keys((body.questions as any).c0.criteria)).toEqual(["original", "retranslation", "same"]);
      return { ok: true, status: 200, json: async () => ({ answers: { c0: { choice: "original" }, c1: { choice: "same" } } }) } as any;
    });
    expect(await chooseWithJev(items, "KEY", { fetchImpl: f as any })).toEqual(["original", "same"]);
  });
  it("returns null for a failed request", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as any);
    expect(await chooseWithJev(items, "KEY", { fetchImpl: f as any })).toEqual([null, null]);
  });
});

describe("retranslation selection rules", () => {
  it("code-flagged: clean retranslation wins without Jev", () => {
    expect(needsJevChoice(["simplified"], [])).toBe(false);
    expect(pickRetranslation(["simplified"], [], null)).toBe("retranslation");
  });
  it("code-flagged: still dirty → Jev decides, tie keeps retranslation", () => {
    expect(needsJevChoice(["simplified"], ["simplified"])).toBe(true);
    expect(pickRetranslation(["simplified"], ["simplified"], "original")).toBe("original");
    expect(pickRetranslation(["simplified"], ["simplified"], "same")).toBe("retranslation");
    expect(pickRetranslation(["simplified"], ["simplified"], null)).toBe("retranslation");
  });
  it("Jev-flagged: retranslation introducing a code issue loses without Jev", () => {
    expect(needsJevChoice([], ["untranslated"])).toBe(false);
    expect(pickRetranslation([], ["untranslated"], null)).toBe("original");
  });
  it("Jev-flagged: clean retranslation → Jev decides", () => {
    expect(needsJevChoice([], [])).toBe(true);
    expect(pickRetranslation([], [], "original")).toBe("original");
    expect(pickRetranslation([], [], "retranslation")).toBe("retranslation");
  });
});
