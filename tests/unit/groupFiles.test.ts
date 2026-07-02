import { describe, it, expect } from "vitest";
import { groupFilesByFolder } from "../../electron/main/utils/pipeline";

describe("groupFilesByFolder", () => {
  it("groups by dirname and natural-sorts within group", () => {
    const groups = groupFilesByFolder([
      { path: "/show-a/EP10.srt", name: "EP10.srt" },
      { path: "/show-b/01.srt", name: "01.srt" },
      { path: "/show-a/EP2.srt", name: "EP2.srt" },
      { path: "/show-a/EP1.srt", name: "EP1.srt" },
    ]);
    expect(groups).toHaveLength(2);
    const showA = groups.find((g) => g[0].path.startsWith("/show-a"))!;
    expect(showA.map((f) => f.name)).toEqual(["EP1.srt", "EP2.srt", "EP10.srt"]);
  });
});
