import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
vi.mock("ai", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    generateText: (...args: any[]) => generateTextMock(...args),
  };
});

import { analyzeSubtitlesForContext } from "../../electron/main/utils/translate";

const OPTS = { apiKeys: ["k"], apiHost: "https://h/v1", model: "m", lang: "zh-TW" };

beforeEach(() => {
  generateTextMock.mockReset().mockResolvedValue({
    text: JSON.stringify({ plotSummary: "p", glossary: [] }),
  });
});

describe("analyzeSubtitlesForContext", () => {
  it("accepts only the four glossary categories", async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        plotSummary: "p",
        glossary: [{ term: "Neo", translation: "尼歐", category: "person" }],
      }),
    });
    await expect(analyzeSubtitlesForContext(["line"], OPTS)).resolves.toEqual({
      plotSummary: "p",
      glossary: [{ term: "Neo", translation: "尼歐", category: "person" }],
    });
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        plotSummary: "p",
        glossary: [{ term: "run", translation: "跑", category: "verb" }],
      }),
    });
    await expect(analyzeSubtitlesForContext(["line"], OPTS)).rejects.toThrow(
      "did not match schema"
    );
  });

  // oMLX JSON 模式在 E01 第 2 段穩定回 "[1.0]"；改走 generateText 後，
  // 退化回應仍會重試一次，第二次正常即成功
  it("retries once on a degenerate response like [1.0]", async () => {
    generateTextMock
      .mockResolvedValueOnce({ text: "[1.0]" })
      .mockResolvedValueOnce({
        text: '[{"plotSummary":"p","glossary":[]}]',
      });
    await expect(analyzeSubtitlesForContext(["line"], OPTS)).resolves.toEqual({
      plotSummary: "p",
      glossary: [],
    });
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the raw response on the error after exhausting retries", async () => {
    generateTextMock.mockResolvedValue({ text: "[1.0]" });
    await expect(analyzeSubtitlesForContext(["line"], OPTS)).rejects.toMatchObject({
      name: "JsonOutputError",
      text: "[1.0]",
    });
  });

  it("disableThinking sends chat_template_kwargs to turn off thinking", async () => {
    await analyzeSubtitlesForContext(["line"], { ...OPTS, disableThinking: true });
    expect(generateTextMock.mock.calls[0][0].providerOptions).toEqual({
      openai: { chat_template_kwargs: { enable_thinking: false } },
    });
    generateTextMock.mockClear();
    await analyzeSubtitlesForContext(["line"], OPTS);
    expect(generateTextMock.mock.calls[0][0].providerOptions).toBeUndefined();
  });

  it("does not retry network errors", async () => {
    generateTextMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(analyzeSubtitlesForContext(["line"], OPTS)).rejects.toThrow("ECONNREFUSED");
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("prompt limits glossary to 15 proper-noun entries", async () => {
    await analyzeSubtitlesForContext(["line"], OPTS);
    const { system } = generateTextMock.mock.calls[0][0];
    expect(system).toContain("Up to 15");
    expect(system).toMatch(/proper nouns/i);
  });

  it("injects existing glossary as mandatory translations", async () => {
    await analyzeSubtitlesForContext(["line"], {
      ...OPTS,
      existingGlossary: [{ term: "Neo", translation: "尼歐", category: "person" }],
    });
    const { system } = generateTextMock.mock.calls[0][0];
    expect(system).toContain("Neo: 尼歐");
    expect(system).toMatch(/MUST reuse/i);
  });

  it("omits the established-glossary section when none exists", async () => {
    await analyzeSubtitlesForContext(["line"], OPTS);
    const { system } = generateTextMock.mock.calls[0][0];
    expect(system).not.toMatch(/MUST reuse/i);
  });

  it("prompt prefers official published translations when known", async () => {
    await analyzeSubtitlesForContext(["line"], OPTS);
    const { system } = generateTextMock.mock.calls[0][0];
    expect(system).toMatch(/official/i);
  });

  it("prompt requires consistent translations across person-name variants", async () => {
    await analyzeSubtitlesForContext(["line"], OPTS);
    const { system } = generateTextMock.mock.calls[0][0];
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
    const { system } = generateTextMock.mock.calls[0][0];
    expect(system).toMatch(/shorter form|alias/i);
    expect(system).toMatch(/derive/i);
  });
});
