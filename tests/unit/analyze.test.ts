import { describe, it, expect, vi, beforeEach } from "vitest";

const generateObjectMock = vi.fn();
vi.mock("ai", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    generateObject: (...args: any[]) => generateObjectMock(...args),
  };
});

import { analyzeSubtitlesForContext } from "../../electron/main/utils/translate";

const OPTS = { apiKeys: ["k"], apiHost: "https://h/v1", model: "m", lang: "zh-TW" };

beforeEach(() => {
  generateObjectMock.mockReset().mockResolvedValue({
    object: { plotSummary: "p", glossary: [] },
  });
});

describe("analyzeSubtitlesForContext", () => {
  it("schema accepts only the four glossary categories", async () => {
    await analyzeSubtitlesForContext(["line"], OPTS);
    const { schema } = generateObjectMock.mock.calls[0][0];
    expect(() =>
      schema.parse({
        plotSummary: "p",
        glossary: [{ term: "Neo", translation: "尼歐", category: "person" }],
      })
    ).not.toThrow();
    expect(() =>
      schema.parse({
        plotSummary: "p",
        glossary: [{ term: "run", translation: "跑", category: "verb" }],
      })
    ).toThrow();
    expect(() =>
      schema.parse({
        plotSummary: "p",
        glossary: [{ term: "Neo", translation: "尼歐" }], // 缺 category
      })
    ).toThrow();
  });

  it("prompt limits glossary to 15 proper-noun entries", async () => {
    await analyzeSubtitlesForContext(["line"], OPTS);
    const { system } = generateObjectMock.mock.calls[0][0];
    expect(system).toContain("Up to 15");
    expect(system).toMatch(/proper nouns/i);
  });

  it("injects existing glossary as mandatory translations", async () => {
    await analyzeSubtitlesForContext(["line"], {
      ...OPTS,
      existingGlossary: [{ term: "Neo", translation: "尼歐", category: "person" }],
    });
    const { system } = generateObjectMock.mock.calls[0][0];
    expect(system).toContain("Neo: 尼歐");
    expect(system).toMatch(/MUST reuse/i);
  });

  it("omits the established-glossary section when none exists", async () => {
    await analyzeSubtitlesForContext(["line"], OPTS);
    const { system } = generateObjectMock.mock.calls[0][0];
    expect(system).not.toMatch(/MUST reuse/i);
  });

  it("prompt prefers official published translations when known", async () => {
    await analyzeSubtitlesForContext(["line"], OPTS);
    const { system } = generateObjectMock.mock.calls[0][0];
    expect(system).toMatch(/official/i);
  });

  it("prompt requires consistent translations across person-name variants", async () => {
    await analyzeSubtitlesForContext(["line"], OPTS);
    const { system } = generateObjectMock.mock.calls[0][0];
    expect(system).toMatch(/same person/i);
    expect(system).toMatch(/mutually consistent/i);
    // prompt 不得寫死具體人名或譯名，避免汙染輸出
    expect(system).not.toContain("Hong Hye-in");
    expect(system).not.toMatch(/[一-鿿]/);
  });

  it("injection instructs deriving alias translations from established terms", async () => {
    await analyzeSubtitlesForContext(["line"], {
      ...OPTS,
      existingGlossary: [{ term: "Neo", translation: "尼歐", category: "person" }],
    });
    const { system } = generateObjectMock.mock.calls[0][0];
    expect(system).toMatch(/shorter form|alias/i);
    expect(system).toMatch(/derive/i);
  });
});
