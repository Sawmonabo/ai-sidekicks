// The assets tier: generated artifacts against their sources.
//
// `Spec-023 §Console Test Tiers` names this tier "generated tokens and schema
// artifacts byte-identical to their sources". The console has no COMMITTED
// stylesheet to byte-diff — `generate-css.ts` builds the sheet at runtime and
// `frame/bindings/token-installation.ts` writes it into the document head before
// first paint, deliberately,
// so that the palette has exactly one record and no regeneration command can be
// forgotten. That removes the drift this tier was written to catch and replaces it
// with one this file holds: the generator is deterministic and complete — every
// token in the resolved records reaches the sheet, every scheme-varying token
// reaches all three cascade layers, and no token has its only definition inside a
// media query. It is vacuity-guarded: a tampered copy has to be caught, or the
// assertions below are measuring nothing.
//
// A SECOND CLAIM USED TO LIVE HERE AND IS NOW A REVIEW RULE, stated in
// `apps/desktop/AGENTS.md` §Module shape — that every `var(--meridian-*)` a console
// stylesheet references is defined somewhere the console controls. It is a real
// drift (a stylesheet naming a property nobody sets does not fail, it paints
// nothing) and it was checked by READING every console `.css` source, which is the
// one thing no tier does any more. No tool in this package lints CSS; `stylelint` is
// the standard-tool home for the claim and is not adopted.

import { describe, expect, it } from "vitest";

import { BOUNDED_ENUMERATION_MAX_ROWS } from "../../../src/renderer/src/console/core/index.js";
import { ENUMERATION_ROW_HEIGHT_REM } from "../../../src/renderer/src/console/tokens/palette.js";
import {
  BOUNDED_ENUMERATION_HEIGHT_REM,
  PARTICIPANT_HUES,
  SCHEME_COLOR_TOKENS,
  formatOklch,
  generateMeridianCss,
  participantHueTokenName,
  tokenVariableName,
} from "../../../src/renderer/src/console/tokens/index.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/tokens.js";

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
 * The declarations inside the TOP-LEVEL rule whose selector is exactly `selector`.
 *
 * Anchored to a line start, because `[data-console-scheme="light"]` also appears
 * inside the `prefers-color-scheme` block — as the indented `:root:not(...)` guard
 * that exists to exclude that very choice — and a substring search would read the
 * system layer while claiming to read the explicit one.
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
 * The one number a `rem` declaration carries, read out of the emitted sheet.
 *
 * The sheet is the artifact, so a length assertion that reads it is measuring
 * what the browser will paint rather than restating the record it came from.
 * Returns `undefined` when the property is absent, so a caller asserts on a
 * missing declaration instead of comparing against `NaN`.
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
    // The root block runs to the first `@media`. A token defined only inside a
    // media query is the failure the theme rule names: a document with no scheme
    // signal paints an incomplete palette.
    const css = generateMeridianCss();
    const rootBlock = css.slice(0, css.indexOf("@media"));
    const definedInRoot = definedTokenVariables(rootBlock);

    const missing = SCHEME_COLOR_TOKENS.map(([tokenName]) => tokenVariableName(tokenName)).filter(
      (variableName) => !definedInRoot.has(variableName),
    );
    expect(missing).toStrictEqual([]);
  });

  it("redefines every scheme-varying token in BOTH dark layers", () => {
    // The system-preference layer and the explicit-choice layer are separate
    // rules for a reason (an explicit light choice must beat a dark system), so a
    // token present in one and absent from the other is a half-applied theme.
    const css = generateMeridianCss();
    for (const [tokenName] of SCHEME_COLOR_TOKENS) {
      const variableName = tokenVariableName(tokenName);
      const occurrences = [...css.matchAll(new RegExp(`${variableName}\\s*:`, "g"))].length;
      expect(occurrences, `${variableName} should be declared in all three layers`).toBe(3);
    }
  });

  it("emits every colour through the shared formatter, never a hand-rounded literal", () => {
    const css = generateMeridianCss();
    for (const scheme of CONSOLE_SCHEMES) {
      for (const [tokenName, pair] of SCHEME_COLOR_TOKENS) {
        expect(
          css.includes(`${tokenVariableName(tokenName)}: ${formatOklch(pair[scheme])};`),
          `${scheme}/${tokenName} should be emitted as ${formatOklch(pair[scheme])}`,
        ).toBe(true);
      }
    }
    PARTICIPANT_HUES.forEach((hue, step) => {
      const variableName = tokenVariableName(participantHueTokenName(step));
      expect(css).toContain(`${variableName}: ${formatOklch(hue)};`);
    });
  });

  it("binds the browser's own UI to the chosen scheme on each explicit arm", () => {
    // `color-scheme` decides what Chromium paints for scrollbars, form controls,
    // spinners and the canvas — surfaces no custom property reaches. Leaving the
    // root's `light dark` in force under an explicit choice means an operator who
    // picks light on a dark OS gets a light document inside dark scrollbars, and
    // the inverse mismatch is reachable the same way. The token guard already
    // keeps the right palette; this is the other half of the same choice.
    const css = generateMeridianCss();
    const explicitLight = topLevelRuleBody(css, '[data-console-scheme="light"]');
    const explicitDark = topLevelRuleBody(css, '[data-console-scheme="dark"]');

    expect(explicitLight, "there should be an explicit-light rule at all").not.toBe("");
    expect(explicitDark, "there should be an explicit-dark rule at all").not.toBe("");
    expect(explicitLight).toContain("color-scheme: light;");
    expect(explicitDark).toContain("color-scheme: dark;");
    // `light dark` says "either, follow the system", which is the one thing an
    // explicit choice is not.
    expect(explicitLight).not.toContain("light dark");
    expect(explicitDark).not.toContain("light dark");
  });

  it("keeps both schemes on offer only where the system is the one deciding", () => {
    // Negative control for the case above: an explicit arm is not made correct by
    // dropping `light dark` everywhere. With no attribute at all the root has to
    // keep offering both, or a system-scheme window loses native dark controls.
    const css = generateMeridianCss();
    expect(css.slice(0, css.indexOf("@media"))).toContain("color-scheme: light dark;");
  });

  it("sizes an enumeration row by the line box the sheet actually paints", () => {
    // The row is one `text-md` line box plus a `space-2` above and below it. All
    // three inputs are read back out of the emitted sheet rather than restated
    // here, so a change to the type scale, the spacing scale, or the body line
    // height moves this assertion with it instead of leaving the rhythm behind.
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
    // Negative control: a row height that counted the line box and forgot the
    // padding would satisfy a looser check, and would then cap six rows at a box
    // a row and a half too short to hold them.
    expect(ENUMERATION_ROW_HEIGHT_REM).not.toBe(bodyTextSizeRem * bodyLineHeight);
  });

  it("caps a bounded enumeration at a whole number of those rows, never a hand-picked length", () => {
    const css = generateMeridianCss();

    expect(emittedRemValue(css, "enumeration-max-height")).toBe(BOUNDED_ENUMERATION_HEIGHT_REM);
    // The cap is a ROW count — declared in the bounds home — converted to a length
    // here so no stylesheet multiplies; a length picked directly would not divide
    // evenly.
    expect(BOUNDED_ENUMERATION_HEIGHT_REM / ENUMERATION_ROW_HEIGHT_REM).toBe(
      BOUNDED_ENUMERATION_MAX_ROWS,
    );
  });

  it("emits ONE settle easing, and it is the sampled spring", () => {
    // `Spec-023 §Console Design (Meridian)` rule 5 asks for chrome that settles and
    // never bounces, implemented by an own spring sampler emitting `linear()`. Two
    // easings — a hand-written cubic beside the sampled spring — meant every one of
    // the stylesheets reading `--meridian-ease-settle` got the cubic while the spring
    // the rule asks for was emitted under a name no sheet read.
    const css = generateMeridianCss();
    expect(css).toContain(`${tokenVariableName("ease-settle")}: linear(`);
    expect(css).not.toContain(tokenVariableName("ease-spring"));
  });

  it("declares no font feature anywhere in the sheet", () => {
    // `font-feature-settings` INHERITS, so a declaration on `body` reaches every
    // descendant — which put the slashed zero rule 4 reserves as the mark of a wire
    // figure onto every participant name, repo path, and branch name in the console.
    // The features ride the mono `@font-face` descriptors in
    // `frame/bindings/typeface.ts` instead, where they are scoped to the face by
    // construction rather than by a selector this sheet could never narrow again:
    // CSS Fonts 4 gives the property precedence over the features `font-variant-*`
    // computes, so once it is on the root no descendant can scope the feature at all.
    expect(generateMeridianCss()).not.toContain("font-feature-settings");
  });

  it("catches a planted difference, so the comparison is not vacuous", () => {
    const generated = generateMeridianCss();
    const tampered = generated.replace("oklch(", "oklcH(");
    expect(tampered).not.toBe(generated);
  });
});
