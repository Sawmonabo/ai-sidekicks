// The generated token sheet against its sources. The console has no committed stylesheet to
// byte-diff: `generate-css.ts` builds the sheet at runtime and `app/token-installation.ts` writes
// it into the document head. So this file holds that the generator is deterministic and complete:
// every token reaches the sheet, every scheme-varying token reaches all three cascade layers, and
// none has its only definition inside a media query.

import { describe, expect, it } from "vitest";

import { BOUNDED_ENUMERATION_MAX_ROWS } from "./palette.js";
import { ENUMERATION_ROW_HEIGHT_REM } from "./palette.js";
import { BOUNDED_ENUMERATION_HEIGHT_REM } from "./palette.js";
import {
  HUE_WHEEL,
  SCHEME_COLOR_TOKENS,
  formatHueWheelTokenName,
  tokenVariableName,
} from "./tokens.js";
import { formatOklch } from "./color.js";
import { generateMeridianCss } from "./generate-css.js";
import { COLOR_SCHEMES } from "./tokens.js";

/** Custom-property NAMES a declaration block defines, e.g. `--meridian-text`. */
function definedTokenVariables(css: string): Set<string> {
  const defined = new Set<string>();
  for (const match of css.matchAll(/^\s*(--meridian-[a-z0-9-]+)\s*:/gm)) {
    const name = match[1];
    if (name !== undefined) {
      defined.add(name);
    }
  }
  return defined;
}

/**
 * The declarations inside the top-level rule whose selector is exactly `selector`. Anchored to a
 * line start because `[data-color-scheme="light"]` also appears in the indented `:root:not(...)`
 * guard inside the `prefers-color-scheme` block, and a substring search would read that layer.
 */
function topLevelRuleBody(css: string, selector: string): string {
  const opening = `\n${selector} {\n`;
  const start = css.indexOf(opening);
  if (start === -1) {
    return "";
  }
  const bodyStart = start + opening.length;
  const end = css.indexOf("\n}", bodyStart);
  return end === -1 ? "" : css.slice(bodyStart, end);
}

/**
 * The one number a `rem` declaration carries, read out of the emitted sheet, so a length
 * assertion measures what the browser paints. `undefined` when the property is absent.
 */
function emittedRemValue(css: string, tokenName: string): number | undefined {
  const matched = new RegExp(`${tokenVariableName(tokenName)}: ([\\d.]+)rem;`).exec(css);
  return matched?.[1] === undefined ? undefined : Number(matched[1]);
}

/** The unitless multiplier a `line-height` declaration carries. */
function emittedLineHeight(css: string): number | undefined {
  const matched = /line-height: ([\d.]+);/.exec(css);
  return matched?.[1] === undefined ? undefined : Number(matched[1]);
}

describe("assets — the generated token sheet", () => {
  it("is deterministic, byte for byte", () => {
    expect(generateMeridianCss()).toBe(generateMeridianCss());
  });

  it("defines every scheme-varying token in the unconditional root block", () => {
    // The root block runs to the first `@media`. A token defined only inside a media query leaves
    // a document with no scheme signal with an incomplete palette.
    const css = generateMeridianCss();
    const rootBlock = css.slice(0, css.indexOf("@media"));
    const definedInRoot = definedTokenVariables(rootBlock);

    const missing = SCHEME_COLOR_TOKENS.map(([tokenName]) => tokenVariableName(tokenName)).filter(
      (variableName) => !definedInRoot.has(variableName),
    );
    expect(missing).toStrictEqual([]);
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

  it("binds the browser's own UI to the chosen scheme on each explicit arm", () => {
    // `color-scheme` decides what Chromium paints for scrollbars, form controls and the canvas,
    // which no custom property reaches. Leaving the root's `light dark` under an explicit choice
    // would put a light document inside dark scrollbars, or the reverse. The token guard keeps the
    // palette; this keeps the browser's own UI.
    const css = generateMeridianCss();
    const explicitLight = topLevelRuleBody(css, '[data-color-scheme="light"]');
    const explicitDark = topLevelRuleBody(css, '[data-color-scheme="dark"]');

    expect(explicitLight, "there should be an explicit-light rule at all").not.toBe("");
    expect(explicitDark, "there should be an explicit-dark rule at all").not.toBe("");
    expect(explicitLight).toContain("color-scheme: light;");
    expect(explicitDark).toContain("color-scheme: dark;");
    // `light dark` means "follow the system", which an explicit choice is not.
    expect(explicitLight).not.toContain("light dark");
    expect(explicitDark).not.toContain("light dark");
  });

  it("keeps both schemes on offer only where the system is the one deciding", () => {
    // Negative control: with no attribute the root must keep offering both, or a system-scheme
    // window loses native dark controls.
    const css = generateMeridianCss();
    expect(css.slice(0, css.indexOf("@media"))).toContain("color-scheme: light dark;");
  });

  it("sizes an enumeration row by the line box the sheet actually paints", () => {
    // The row is one `text-md` line box plus a `space-2` above and below. All three inputs are read
    // from the emitted sheet, so a change to any of them moves this assertion with it.
    const css = generateMeridianCss();
    const bodyLineHeight = emittedLineHeight(css);
    const bodyTextSizeRem = emittedRemValue(css, "text-md");
    const rowPaddingRem = emittedRemValue(css, "space-2");

    expect(bodyLineHeight).toBeDefined();
    expect(bodyTextSizeRem).toBeDefined();
    expect(rowPaddingRem).toBeDefined();
    if (
      bodyLineHeight === undefined ||
      bodyTextSizeRem === undefined ||
      rowPaddingRem === undefined
    ) {
      return;
    }
    expect(ENUMERATION_ROW_HEIGHT_REM).toBe(bodyTextSizeRem * bodyLineHeight + 2 * rowPaddingRem);
    // Negative control: a height that forgot the padding would satisfy a looser check and cap six
    // rows a row and a half too short.
    expect(ENUMERATION_ROW_HEIGHT_REM).not.toBe(bodyTextSizeRem * bodyLineHeight);
  });

  it("caps a bounded enumeration at a whole number of those rows, never a hand-picked length", () => {
    const css = generateMeridianCss();

    expect(emittedRemValue(css, "enumeration-max-height")).toBe(BOUNDED_ENUMERATION_HEIGHT_REM);
    // The cap is a row count converted to a length here so no stylesheet multiplies; a hand-picked
    // length would not divide evenly.
    expect(BOUNDED_ENUMERATION_HEIGHT_REM / ENUMERATION_ROW_HEIGHT_REM).toBe(
      BOUNDED_ENUMERATION_MAX_ROWS,
    );
  });

  it("emits ONE settle easing, and it is the sampled spring", () => {
    // Two easings (a hand-written cubic beside the sampled spring) meant every sheet reading
    // `--meridian-ease-settle` got the cubic while the spring sat under a name none read. The
    // sampler runs at build time: `motion.ts` carries its answer and `motion.test.ts` re-derives
    // it, so this asserts the emitted shape.
    const css = generateMeridianCss();
    expect(css).toContain(`${tokenVariableName("ease-settle")}: linear(`);
    expect(css).not.toContain(tokenVariableName("ease-spring"));
  });

  it("declares no font feature anywhere in the sheet", () => {
    // `font-feature-settings` inherits, so a declaration on `body` would put the slashed zero,
    // the mark of a wire figure, on every user name, path and branch. The features ride the mono
    // `@font-face` descriptors in `typeface.ts`, scoped to the face; on the root no descendant
    // could scope them back, since CSS Fonts 4 gives the property precedence over `font-variant-*`.
    expect(generateMeridianCss()).not.toContain("font-feature-settings");
  });

  it("catches a planted difference, so the comparison is not vacuous", () => {
    const generated = generateMeridianCss();
    const tampered = generated.replace("oklch(", "oklcH(");
    expect(tampered).not.toBe(generated);
  });
});
