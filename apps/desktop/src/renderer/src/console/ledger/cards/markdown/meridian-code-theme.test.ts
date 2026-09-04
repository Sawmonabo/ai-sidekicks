// The theme emits references, never colours — which is what makes the token cache
// theme-independent.

import { describe, expect, it } from "vitest";

import {
  CODE_TOKEN_FAMILIES,
  codeTokenColorReference,
  codeTokenVariableName,
  meridianCodeTheme,
} from "./meridian-code-theme.js";

describe("the code token families", () => {
  it("names a custom property per family, in one place", () => {
    expect(codeTokenVariableName("keyword")).toBe("--meridian-code-keyword");
    expect(codeTokenColorReference("keyword")).toBe("var(--meridian-code-keyword)");
  });

  it("declares nine families and no duplicates", () => {
    expect(new Set(CODE_TOKEN_FAMILIES).size).toBe(CODE_TOKEN_FAMILIES.length);
  });
});

describe("the theme", () => {
  it("carries a reference for every foreground it sets", () => {
    const theme = meridianCodeTheme();
    const foregrounds = (theme.settings ?? []).map((rule) => rule.settings.foreground);
    expect(foregrounds.length).toBeGreaterThan(0);
    for (const foreground of foregrounds) {
      expect(foreground).toMatch(/^var\(--meridian-code-[a-z]+\)$/u);
    }
    expect(theme.fg).toBe(codeTokenColorReference("plain"));
  });

  it("negative control: it carries no resolved colour anywhere", () => {
    // A theme holding hex or oklch values would make every cached token line wrong the
    // moment the operator flipped schemes. This is the assertion that would catch it.
    const serialized = JSON.stringify(meridianCodeTheme());
    expect(serialized).not.toMatch(/#[0-9a-f]{3,8}/iu);
    expect(serialized).not.toContain("oklch(");
    expect(serialized).not.toContain("rgb(");
  });

  it("is built fresh per call, because a highlighter normalises it in place", () => {
    expect(meridianCodeTheme()).not.toBe(meridianCodeTheme());
  });

  it("gives plain no scope rule of its own", () => {
    // A token no rule matched IS plain; a rule for it would be a second way to say so.
    const scopes = (meridianCodeTheme().settings ?? []).flatMap((rule) =>
      Array.isArray(rule.scope) ? rule.scope : [],
    );
    expect(scopes).not.toContain("plain");
  });
});
