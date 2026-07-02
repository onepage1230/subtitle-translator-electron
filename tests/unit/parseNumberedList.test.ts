import { describe, it, expect } from "vitest";
import { parseNumberedList } from "../../electron/main/utils/translate";

describe("parseNumberedList", () => {
  it("parses a well-formed numbered list", () => {
    expect(parseNumberedList("1. 甲\n2. 乙\n3. 丙", 3)).toEqual(["甲", "乙", "丙"]);
  });
  it("returns null on count mismatch", () => {
    expect(parseNumberedList("1. 甲\n2. 乙", 3)).toBeNull();
  });
  it("ignores surrounding prose lines", () => {
    expect(parseNumberedList("Here you go:\n1. 甲\n2. 乙\nDone!", 2)).toEqual(["甲", "乙"]);
  });
});
