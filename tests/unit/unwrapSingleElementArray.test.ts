import { describe, it, expect } from "vitest";
import { unwrapSingleElementArray } from "../../electron/main/utils/translate";

describe("unwrapSingleElementArray", () => {
  it("拆開單元素物件陣列", () => {
    const text = '[{"plotSummary":"s","glossary":[]}]';
    expect(JSON.parse(unwrapSingleElementArray(text)!)).toEqual({ plotSummary: "s", glossary: [] });
  });
  it("非物件或多元素時回 null", () => {
    expect(unwrapSingleElementArray("[1.0]")).toBeNull();
    expect(unwrapSingleElementArray('["plotSummary","glossary"]')).toBeNull();
    expect(unwrapSingleElementArray('[{"a":1},{"b":2}]')).toBeNull();
    expect(unwrapSingleElementArray("not json")).toBeNull();
  });
});
