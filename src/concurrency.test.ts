import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "./concurrency.js";

describe("runWithConcurrency", () => {
  it("never exceeds the requested worker count", async () => {
    let active = 0;
    let maximum = 0;
    const completed: number[] = [];
    await runWithConcurrency([0, 1, 2, 3, 4, 5], 3, async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed.push(value);
      active -= 1;
    });
    expect(maximum).toBe(3);
    expect(completed.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("rejects invalid limits", async () => {
    await expect(runWithConcurrency([1], 0, async () => undefined)).rejects.toThrow("positive integer");
  });
});
