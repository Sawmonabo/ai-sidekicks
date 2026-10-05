import { describe, expect, it } from "vitest";

import { resolveHighlightableLanguage } from "./languages.js";

describe("resolving a fence's info string", () => {
  it("an unknown language resolves to nothing", () => {
    expect(resolveHighlightableLanguage("brainfuck")).toBeUndefined();
    expect(resolveHighlightableLanguage("../../etc/passwd")).toBeUndefined();
    expect(resolveHighlightableLanguage("")).toBeUndefined();
    expect(resolveHighlightableLanguage(null)).toBeUndefined();
    expect(resolveHighlightableLanguage(undefined)).toBeUndefined();
  });

  it("is not fooled by a prototype member name", () => {
    expect(resolveHighlightableLanguage("constructor")).toBeUndefined();
    expect(resolveHighlightableLanguage("__proto__")).toBeUndefined();
    expect(resolveHighlightableLanguage("toString")).toBeUndefined();
  });
});
