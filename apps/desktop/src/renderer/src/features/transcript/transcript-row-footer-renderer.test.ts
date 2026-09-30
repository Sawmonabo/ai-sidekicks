// Who may register in the footer renderer registry.

import { afterEach, describe, expect, it } from "vitest";

import {
  registerTranscriptRowFooterRenderer,
  findTranscriptRowFooterRenderer,
  unregisterTranscriptRowFooterRenderer,
} from "./transcript-row-footer-renderer.js";

afterEach(() => {
  unregisterTranscriptRowFooterRenderer();
});

describe("the transcript row footer renderer registry", () => {
  it("is empty until an owner fills it", () => {
    expect(findTranscriptRowFooterRenderer()).toBeUndefined();
    registerTranscriptRowFooterRenderer("an owner", () => null);
    expect(findTranscriptRowFooterRenderer()).toBeDefined();
  });

  it("refuses a second owner rather than swapping", () => {
    registerTranscriptRowFooterRenderer("first owner", () => null);
    expect(() => {
      registerTranscriptRowFooterRenderer("second owner", () => null);
    }).toThrow(/second owner/);
  });

  it("admits the same owner again, for a hot reload", () => {
    registerTranscriptRowFooterRenderer("one owner", () => null);
    expect(() => {
      registerTranscriptRowFooterRenderer("one owner", () => null);
    }).not.toThrow();
  });
});
