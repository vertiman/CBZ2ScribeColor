import { describe, expect, it } from "vitest";
import { groupIntoBundles } from "./bundles.js";

describe("groupIntoBundles", () => {
  it("preserves sorted source order and numbers full and partial bundles", () => {
    const bundles = groupIntoBundles(
      ["001.cbz", "002.cbz", "003.cbz", "004.cbz", "005.cbz"],
      2,
      "Reading Order",
    );

    expect(bundles).toEqual([
      { index: 1, title: "Reading Order - 001", sources: ["001.cbz", "002.cbz"] },
      { index: 2, title: "Reading Order - 002", sources: ["003.cbz", "004.cbz"] },
      { index: 3, title: "Reading Order - 003", sources: ["005.cbz"] },
    ]);
  });

  it("rejects invalid sizes and empty names", () => {
    expect(() => groupIntoBundles(["001.cbz"], 0, "Name")).toThrow("positive integer");
    expect(() => groupIntoBundles(["001.cbz"], 1, "   ")).toThrow("must not be empty");
  });
});
