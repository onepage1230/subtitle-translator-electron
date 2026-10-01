import { describe, it, expect } from "vitest";
import { z } from "zod";
import { extractJson, parseJsonOutput } from "../../electron/main/utils/jsonOutput";

describe("extractJson", () => {
  it("parses a plain object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("strips think blocks and code fences", () => {
    expect(extractJson('<think>{"x":0}</think>\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("takes only the first complete value and ignores trailing text", () => {
    expect(extractJson('Sure! {"a":"}{"} and then {"b":2} repeated...')).toEqual({ a: "}{" });
  });
  it("handles escaped quotes inside strings", () => {
    expect(extractJson('{"a":"say \\"hi\\" ]"}')).toEqual({ a: 'say "hi" ]' });
  });
  it("returns undefined for no JSON or a truncated value", () => {
    expect(extractJson("no json here")).toBeUndefined();
    expect(extractJson('{"a": "cut off')).toBeUndefined();
  });
});

describe("parseJsonOutput", () => {
  const schema = z.object({ a: z.number() });
  it("applies normalize before validating", () => {
    expect(parseJsonOutput("[{\"a\":1}]", schema, (v: any) => v[0])).toEqual({ a: 1 });
  });
  it("throws JsonOutputError carrying the raw text", () => {
    expect(() => parseJsonOutput("[1.0]", schema)).toThrowError(
      expect.objectContaining({ name: "JsonOutputError", text: "[1.0]" })
    );
  });
});
