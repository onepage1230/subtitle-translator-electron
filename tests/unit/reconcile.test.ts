import { describe, it, expect, vi, beforeEach } from "vitest";

const generateObjectMock = vi.fn();
vi.mock("ai", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    generateObject: (...args: any[]) => generateObjectMock(...args),
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
  generateObjectMock.mockReset().mockResolvedValue({
    object: { glossary: [] },
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
    const { system } = generateObjectMock.mock.calls[0][0];
    expect(system).toMatch(/romanization variants/i);
    expect(system).toMatch(/identical translation/i);
    expect(system).toMatch(/LOCKED/);
    expect(system).toMatch(/do not invent/i);
  });

  it("prompt carries locked and new entries with translations", async () => {
    await reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS);
    const { prompt } = generateObjectMock.mock.calls[0][0];
    expect(prompt).toContain("Baek Hyeon-woo: 白賢祐");
    expect(prompt).toContain("Baek Hyun-woo: 白賢宇");
    expect(prompt).toMatch(/LOCKED/);
    expect(prompt).toMatch(/NEW/);
  });

  it("omits the locked section when no series glossary exists", async () => {
    await reconcileGlossary(NEW_ENTRIES, [], OPTS);
    const { prompt } = generateObjectMock.mock.calls[0][0];
    expect(prompt).not.toMatch(/LOCKED/);
  });

  it("returns the model's reconciled glossary", async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        glossary: [
          { term: "Baek Hyun-woo", translation: "白賢祐", category: "person" },
        ],
      },
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
  const schemaError = (text: string) =>
    Object.assign(new Error("No object generated: response did not match schema."), {
      text,
    });

  it("repairs a flat term→'translation (category)' map", async () => {
    generateObjectMock.mockRejectedValue(
      schemaError(
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
    generateObjectMock.mockRejectedValue(
      schemaError(JSON.stringify({ "Baek Hyun-woo": "白賢祐" }))
    );
    const result = await reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS);
    expect(result).toEqual([
      { term: "Baek Hyun-woo", translation: "白賢祐", category: "person" },
    ]);
  });

  it("unwraps a glossary-keyed flat map", async () => {
    generateObjectMock.mockRejectedValue(
      schemaError(JSON.stringify({ glossary: { "Baek Hyun-woo": "白賢祐 (person)" } }))
    );
    const result = await reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS);
    expect(result).toEqual([
      { term: "Baek Hyun-woo", translation: "白賢祐", category: "person" },
    ]);
  });

  it("accepts a bare entry array missing the wrapper object", async () => {
    generateObjectMock.mockRejectedValue(
      schemaError(
        JSON.stringify([{ term: "Baek Hyun-woo", translation: "白賢祐", category: "person" }])
      )
    );
    const result = await reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS);
    expect(result).toEqual([
      { term: "Baek Hyun-woo", translation: "白賢祐", category: "person" },
    ]);
  });

  it("rethrows when the raw text is not repairable", async () => {
    generateObjectMock.mockRejectedValue(schemaError("sorry, I cannot do that"));
    await expect(reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS)).rejects.toThrow(
      "did not match schema"
    );
  });

  it("rethrows errors that carry no raw text (e.g. network failures)", async () => {
    generateObjectMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(reconcileGlossary(NEW_ENTRIES, LOCKED, OPTS)).rejects.toThrow(
      "ECONNREFUSED"
    );
  });
});
