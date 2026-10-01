import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
vi.mock("ai", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    generateText: (...args: any[]) => generateTextMock(...args),
  };
});

import { reconcileGlossary } from "../../electron/main/utils/translate";

const OPTS = { apiKeys: ["k"], apiHost: "https://h/v1", model: "m", lang: "zh-TW" };

const NEW_ENTRIES = [
  { term: "Baek Hyun-woo", translation: "白賢宇", category: "person" as const },
];
const LOCKED = [
  { term: "Baek Hyeon-woo", translation: "白賢祐", category: "person" as const },
];

beforeEach(() => {
  generateTextMock.mockReset().mockResolvedValue({
    text: JSON.stringify({ glossary: [] }),
  });
});

describe("reconcileGlossary", () => {
  it("throws without api keys", async () => {
    await expect(
      reconcileGlossary(NEW_ENTRIES, LOCKED, { ...OPTS, apiKeys: [] })
    ).rejects.toThrow("No valid API keys");
  });

  it("system prompt states the reconciliation rules", async () => {
    await reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS);
    const { system } = generateTextMock.mock.calls[0][0];
    expect(system).toMatch(/romanization variants/i);
    expect(system).toMatch(/identical translation/i);
    expect(system).toMatch(/LOCKED/);
    expect(system).toMatch(/do not invent/i);
  });

  it("prompt carries locked and new entries with translations", async () => {
    await reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS);
    const { prompt } = generateTextMock.mock.calls[0][0];
    expect(prompt).toContain("Baek Hyeon-woo: 白賢祐");
    expect(prompt).toContain("Baek Hyun-woo: 白賢宇");
    expect(prompt).toMatch(/LOCKED/);
    expect(prompt).toMatch(/NEW/);
  });

  it("omits the locked section when no series glossary exists", async () => {
    await reconcileGlossary(NEW_ENTRIES, [], OPTS);
    const { prompt } = generateTextMock.mock.calls[0][0];
    expect(prompt).not.toMatch(/LOCKED/);
  });

  it("returns the model's reconciled glossary", async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        glossary: [
          { term: "Baek Hyun-woo", translation: "白賢祐", category: "person" },
        ],
      }),
    });
    const result = await reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS);
    expect(result).toEqual([
      { term: "Baek Hyun-woo", translation: "白賢祐", category: "person" },
    ]);
  });
});

// 小模型常把調和結果回成扁平 map（{"term": "譯名 (category)"}）而非
// { glossary: [...] }，schema 驗證失敗。shape-repair 從錯誤附帶的原始
// 文字解析這種固定形狀，救回本地模型的調和能力。
describe("reconcileGlossary shape repair", () => {
  const respond = (text: string) =>
    generateTextMock.mockResolvedValue({ text });

  it("repairs a flat term→'translation (category)' map", async () => {
    respond(
      (
        JSON.stringify({
          "Baek Hyun-woo": "白賢祐 (person)",
          "J Hotel": "J酒店 (place)",
        })
      )
    );
    const result = await reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS);
    expect(result).toEqual([
      { term: "Baek Hyun-woo", translation: "白賢祐", category: "person" },
      { term: "J Hotel", translation: "J酒店", category: "place" },
    ]);
  });

  it("falls back to the input entry's category when the value has no suffix", async () => {
    respond(
      (JSON.stringify({ "Baek Hyun-woo": "白賢祐" }))
    );
    const result = await reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS);
    expect(result).toEqual([
      { term: "Baek Hyun-woo", translation: "白賢祐", category: "person" },
    ]);
  });

  it("unwraps a glossary-keyed flat map", async () => {
    respond(
      (JSON.stringify({ glossary: { "Baek Hyun-woo": "白賢祐 (person)" } }))
    );
    const result = await reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS);
    expect(result).toEqual([
      { term: "Baek Hyun-woo", translation: "白賢祐", category: "person" },
    ]);
  });

  it("repairs an array of 'term: translation (category)' strings", async () => {
    respond(
      (
        JSON.stringify(["Baek Hyun-woo: 白賢祐 (person)", "J Hotel: J酒店 (place)"])
      )
    );
    const result = await reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS);
    expect(result).toEqual([
      { term: "Baek Hyun-woo", translation: "白賢祐", category: "person" },
      { term: "J Hotel", translation: "J酒店", category: "place" },
    ]);
  });

  it("accepts a bare entry array missing the wrapper object", async () => {
    respond(
      (
        JSON.stringify([{ term: "Baek Hyun-woo", translation: "白賢祐", category: "person" }])
      )
    );
    const result = await reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS);
    expect(result).toEqual([
      { term: "Baek Hyun-woo", translation: "白賢祐", category: "person" },
    ]);
  });

  it("throws when the response holds no JSON", async () => {
    respond("sorry, I cannot do that");
    await expect(reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS)).rejects.toThrow(
      "No JSON value found"
    );
  });

  // 以下三種形狀皆為 2026-09-29/30 本機 Qwen 實際回應
  it("repairs a flat map wrapped in a single-element array", async () => {
    respond('[{"Baek Hyun-woo": "\\u767d\\u8ce2\\u7950", "J Hotel": "J酒店"}]');
    const result = await reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS);
    expect(result).toEqual([
      { term: "Baek Hyun-woo", translation: "白賢祐", category: "person" },
      { term: "J Hotel", translation: "J酒店", category: "term" },
    ]);
  });

  it("repairs entries keyed entry/type instead of term/category", async () => {
    respond(
      JSON.stringify([
        { entry: "Baek Hyun-woo", translation: "白賢祐", type: "person" },
        { entry: "Seoul", translation: "首爾", type: "place" },
      ])
    );
    const result = await reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS);
    expect(result).toEqual([
      { term: "Baek Hyun-woo", translation: "白賢祐", category: "person" },
      { term: "Seoul", translation: "首爾", category: "place" },
    ]);
  });

  it("extracts JSON surrounded by think blocks, fences and prose", async () => {
    respond(
      '<think>hmm {not json}</think>Here you go:\n```json\n{"glossary":[{"term":"Baek Hyun-woo","translation":"白賢祐","category":"person"}]}\n```\nDone.'
    );
    const result = await reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS);
    expect(result).toEqual([
      { term: "Baek Hyun-woo", translation: "白賢祐", category: "person" },
    ]);
  });

  it("system prompt states the exact output shape", async () => {
    await reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS);
    const { system } = generateTextMock.mock.calls[0][0];
    expect(system).toContain('{"glossary": [{"term"');
  });

  it("never sends a response_format / schema to the model", async () => {
    await reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS);
    const args = generateTextMock.mock.calls[0][0];
    expect(args.schema).toBeUndefined();
    expect(args.providerOptions).toBeUndefined();
  });

  it("rethrows errors that carry no raw text (e.g. network failures)", async () => {
    generateTextMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS)).rejects.toThrow(
      "ECONNREFUSED"
    );
  });
});
