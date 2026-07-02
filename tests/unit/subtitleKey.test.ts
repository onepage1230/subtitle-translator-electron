import { describe, it, expect } from "vitest";
import { makeKey } from "../../electron/shared/subtitleKey";

describe("makeKey", () => {
  it("rounds numeric timestamps", () => {
    expect(makeKey(1000.4, 2000.6)).toBe("1000|2001");
  });
  it("trims string timestamps", () => {
    expect(makeKey(" 0:00:01.00 ", "0:00:02.00")).toBe("0:00:01.00|0:00:02.00");
  });
  it("mixed types", () => {
    expect(makeKey(1500, " a ")).toBe("1500|a");
  });
});
