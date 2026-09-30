// The generated token sheet against its sources. The console has no committed stylesheet to
// byte-diff: `generate-css.ts` builds the sheet at runtime and `app/token-installation.ts` writes
// it into the document head. So this file holds that the generator is deterministic and faithful
// to its sources: every scheme-varying token reaches all three cascade layers, and every color
// the sheet emits is its source value through the shared formatter.

import { describe, expect, it } from "vitest";

import {
  COLOR_SCHEMES,
  HUE_WHEEL,
  SCHEME_COLOR_TOKENS,
  formatHueWheelTokenName,
  tokenVariableName,
} from "./tokens.js";
import { formatOklch } from "./color.js";
import { generateMeridianCss } from "./generate-css.js";

describe("assets — the generated token sheet", () => {
  it("is deterministic, byte for byte", () => {
    expect(generateMeridianCss()).toBe(generateMeridianCss());
  });

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

  it("emits every color through the shared formatter, never a hand-rounded literal", () => {
    const css = generateMeridianCss();
    for (const scheme of COLOR_SCHEMES) {
      for (const [tokenName, pair] of SCHEME_COLOR_TOKENS) {
        expect(
          css.includes(`${tokenVariableName(tokenName)}: ${formatOklch(pair[scheme])};`),
          `${scheme}/${tokenName} should be emitted as ${formatOklch(pair[scheme])}`,
        ).toBe(true);
      }
    }
    HUE_WHEEL.forEach((hue, step) => {
      const variableName = tokenVariableName(formatHueWheelTokenName(step));
      expect(css).toContain(`${variableName}: ${formatOklch(hue)};`);
    });
  });
});
