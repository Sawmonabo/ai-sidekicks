import { describe, expect, it } from "vitest";

import { resolveHighlightableLanguage } from "./highlight-languages.js";

describe("resolving a fence's info string", () => {
  it("resolves a language the daemon colors", () => {
    expect(resolveHighlightableLanguage("typescript")).toBe("typescript");
    expect(resolveHighlightableLanguage("bash")).toBe("bash");
  });

  it("resolves an alias to the language it names", () => {
    expect(resolveHighlightableLanguage("ts")).toBe("typescript");
    expect(resolveHighlightableLanguage("sh")).toBe("bash");
    expect(resolveHighlightableLanguage("yml")).toBe("yaml");
  });

  it("reads the info string the way commonmark does", () => {
    expect(resolveHighlightableLanguage("  TypeScript  ")).toBe("typescript");
    expect(resolveHighlightableLanguage("ts title=example.ts")).toBe("typescript");
  });

  it("negative control: an unknown language resolves to nothing", () => {
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
