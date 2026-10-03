// The generated token sheet against its sources. `generate-css.ts` builds the sheet at runtime and
// `app/token-installation.ts` writes it into the document head, so there is no committed
// stylesheet to byte-diff: this holds that every scheme-varying token reaches all three cascade
// layers.

import { describe, expect, it } from "vitest";

import { SCHEME_COLOR_TOKENS, tokenVariableName } from "./tokens.js";
import { generateMeridianCss } from "./generate-css.js";

describe("the generated token sheet", () => {
  it("redefines every scheme-varying token in BOTH dark layers", () => {
    // The system-preference and explicit-choice layers are separate rules (an explicit light
    // choice must beat a dark system), so a token in one and not the other is a half-applied theme.
    const css = generateMeridianCss();
    for (const [tokenName] of SCHEME_COLOR_TOKENS) {
      const variableName = tokenVariableName(tokenName);
      const occurrences = [...css.matchAll(new RegExp(`${variableName}\\s*:`, "g"))].length;
      expect(occurrences, `${variableName} should be declared in all three layers`).toBe(3);
    }
  });
});
