// The color-span budget follows the machine's memory and stays inside its range.

import { describe, expect, it } from "vitest";

import { codeSpanCacheByteCap } from "./code-span-cache-cap.js";

const GIBIBYTE = 1024 * 1024 * 1024;
const MEBIBYTE = 1024 * 1024;

describe("the color-span budget", () => {
  it("takes 1/2048 of the machine's memory inside the range", () => {
    expect(codeSpanCacheByteCap(16 * GIBIBYTE)).toBe(8 * MEBIBYTE);
  });

  it("holds the floor on a small machine and the ceiling on a large one", () => {
    expect(codeSpanCacheByteCap(4 * GIBIBYTE)).toBe(4 * MEBIBYTE);
    expect(codeSpanCacheByteCap(128 * GIBIBYTE)).toBe(16 * MEBIBYTE);
  });
});
