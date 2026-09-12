import { describe, expect, it } from "vitest";
import { queuePosition } from "./queue.ts";
import type { Job } from "../types.ts";

const job = (id: string) => ({ id }) as Job;

describe("queuePosition", () => {
  it("counts from the job that runs next, not from the newest", () => {
    // Newest first, as every job list in the app is; `a` was queued first, so
    // it is the one that runs next.
    const queued = [job("d"), job("c"), job("b"), job("a")];
    expect(queuePosition(queued, "a")).toBe(1);
    expect(queuePosition(queued, "b")).toBe(2);
    expect(queuePosition(queued, "c")).toBe(3);
    expect(queuePosition(queued, "d")).toBe(4);
  });

  it("is 1 when there is only one job waiting", () => {
    expect(queuePosition([job("a")], "a")).toBe(1);
  });

  it("is 0 for a job that is not queued", () => {
    expect(queuePosition([job("a")], "b")).toBe(0);
  });
});
