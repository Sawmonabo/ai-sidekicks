// A closed grammar table — because a specifier composed from message text is a specifier
// a message chose.

import { describe, expect, it } from "vitest";

import {
  HIGHLIGHTABLE_LANGUAGES,
  highlightableLanguages,
  resolveHighlightableLanguage,
} from "./code-tokenizer.js";

describe("resolving a fence's info string", () => {
  it("resolves a language the table names", () => {
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
    // The whole point of the closed table. Without this, a resolver that returned its
    // input would pass every case above and hand the loader a specifier a message chose.
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

describe("the language enumeration", () => {
  it("is the same set the resolver answers from", () => {
    expect(highlightableLanguages()).toStrictEqual(HIGHLIGHTABLE_LANGUAGES);
    for (const language of HIGHLIGHTABLE_LANGUAGES) {
      expect(resolveHighlightableLanguage(language)).toBe(language);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(HIGHLIGHTABLE_LANGUAGES).size).toBe(HIGHLIGHTABLE_LANGUAGES.length);
  });
});
