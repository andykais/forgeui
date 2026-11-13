import { describe, expect, it } from "vitest";
import { diskPath } from "./paths.ts";

describe("diskPath", () => {
  it("puts outputs wherever outputs.dir put them", () => {
    expect(diskPath("/data", "/mnt/big/outputs", "outputs/2026/09/05/01J-0.png")).toBe(
      "/mnt/big/outputs/2026/09/05/01J-0.png",
    );
  });

  it("keeps inputs and samples in the data dir", () => {
    expect(diskPath("/data", "/mnt/big/outputs", "inputs/ab/abc.png")).toBe(
      "/data/inputs/ab/abc.png",
    );
    expect(diskPath("/data", "/mnt/big/outputs", "samples/h/a.png")).toBe(
      "/data/samples/h/a.png",
    );
  });

  it("falls back to the data dir before the status has landed", () => {
    expect(diskPath("/data", "", "outputs/a.png")).toBe("/data/outputs/a.png");
  });
});
