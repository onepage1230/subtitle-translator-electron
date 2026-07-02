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
