import { describe, it, expect } from "vitest";
import { unwrapSingleElementArray } from "../../electron/main/utils/translate";

describe("unwrapSingleElementArray", () => {
  it("拆開單元素物件陣列", () => {
    expect(unwrapSingleElementArray([{ plotSummary: "s", glossary: [] }])).toEqual({
      plotSummary: "s",
      glossary: [],
    });
  });
  it("非物件或多元素時原樣回傳", () => {
    expect(unwrapSingleElementArray([1.0])).toEqual([1.0]);
    expect(unwrapSingleElementArray(["plotSummary", "glossary"])).toEqual(["plotSummary", "glossary"]);
    expect(unwrapSingleElementArray([{ a: 1 }, { b: 2 }])).toEqual([{ a: 1 }, { b: 2 }]);
    expect(unwrapSingleElementArray("x")).toBe("x");
  });
});
