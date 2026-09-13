import { describe, expect, it } from "vitest";
import { isVideoUrl, posterFrame } from "./media.ts";

describe("isVideoUrl", () => {
  it("knows the video containers the app writes", () => {
    expect(isVideoUrl("/api/media/outputs/2026/09/13/01J-0.mp4")).toBe(true);
    expect(isVideoUrl("/api/media/a.webm")).toBe(true);
    expect(isVideoUrl("/api/media/a.MOV")).toBe(true);
  });

  it("leaves images alone", () => {
    expect(isVideoUrl("/api/media/a.png")).toBe(false);
    expect(isVideoUrl("/api/media/a.jpeg")).toBe(false);
    // An animated webp is an image as far as the browser is concerned.
    expect(isVideoUrl("/api/media/a.webp")).toBe(false);
  });

  it("reads the path, not the query or the poster fragment", () => {
    expect(isVideoUrl("/api/media/a.mp4#t=0.1")).toBe(true);
    expect(isVideoUrl("/api/media/a.png?v=2")).toBe(false);
    // A filename is not an extension just because a folder has a dot in it.
    expect(isVideoUrl("/api/media/v1.2/name")).toBe(false);
  });

  it("has an answer for nothing at all", () => {
    expect(isVideoUrl(null)).toBe(false);
    expect(isVideoUrl(undefined)).toBe(false);
    expect(isVideoUrl("")).toBe(false);
  });
});

describe("posterFrame", () => {
  it("seeks a fraction in, so there is a frame to paint", () => {
    expect(posterFrame("/api/media/a.mp4")).toBe("/api/media/a.mp4#t=0.1");
  });

  it("leaves a url that already carries a fragment alone", () => {
    expect(posterFrame("/api/media/a.mp4#t=2")).toBe("/api/media/a.mp4#t=2");
  });
});
