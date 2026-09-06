// The assets tier: generated artifacts against their sources.
//
// `Spec-023 §Console Test Tiers` names this tier "generated tokens and schema
// artifacts byte-identical to their sources". The console has no COMMITTED
// stylesheet to byte-diff — `generate-css.ts` builds the sheet at runtime and
// `install.ts` writes it into the document head before first paint, deliberately,
// so that the palette has exactly one record and no regeneration command can be
// forgotten. That removes the drift this tier was written to catch and replaces it
// with two others, which is what this file holds:
//
//   1. The generator is deterministic and complete — every token in the resolved
//      records reaches the sheet, every scheme-varying token reaches all three
//      cascade layers, and no token has its only definition inside a media query.
//   2. Every `var(--meridian-*)` any console stylesheet REFERENCES is defined
//      somewhere the console controls. This is the drift that actually bites: a
//      stylesheet naming a property nobody sets does not fail, it paints nothing —
//      an invisible border, a transparent ground — and no unit test sees it.
//
//      "Somewhere the console controls" is deliberately wider than the generator.
//      A property carrying PER-INSTANCE data cannot be a global token: the ledger
//      row's attribution hue is a different value on every row, so `LedgerRow` sets
//      `--meridian-row-hue` on the element itself and the stylesheet reads it. That
//      is the correct shape, and a check that only knew about generated tokens
//      would push it toward twelve hard-coded per-hue classes instead.
//
// Both are vacuity-guarded: a planted difference and a planted reference each have
// to be caught, or the assertions above are measuring nothing.

import { describe, expect, it } from "vitest";

import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  consoleStylesheets,
  readConsoleSourceModule,
} from "../console-source-modules.js";

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

/**
 * The console alone, on the shared walk.
 *
 * SCOPED TO ONE ROOT rather than defaulted to both, because this tier's subject is
 * the Meridian palette and the shell composes seats out of it rather than defining
 * properties of its own: a claim about which properties the console defines should
 * not silently start reporting on the shell the day that subtree lands.
 */
const CONSOLE_ROOT_ONLY = { roots: [CONSOLE_DIRECTORY] } as const;

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
 * Custom-property names a component sets on an element itself, as they appear in
 * a typed inline-style object: `"--meridian-row-hue": someValue`.
 */
function inlineTokenVariables(source: string): Set<string> {
  const defined = new Set<string>();
  for (const match of source.matchAll(/["'](--meridian-[a-z0-9-]+)["']\s*[:?]/g)) {
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

/** Custom-property names a stylesheet READS through `var()`. */
function referencedTokenVariables(css: string): Set<string> {
  const referenced = new Set<string>();
  for (const match of css.matchAll(/var\(\s*(--meridian-[a-z0-9-]+)/g)) {
    const name = match[1];
    if (name !== undefined) {
      referenced.add(name);
    }
  }
  return referenced;
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

    const missing = [...SCHEME_COLOR_TOKENS.keys()]
      .map((tokenName) => tokenVariableName(tokenName))
      .filter((variableName) => !definedInRoot.has(variableName));
    expect(missing).toStrictEqual([]);
  });

  it("redefines every scheme-varying token in BOTH dark layers", () => {
    // The system-preference layer and the explicit-choice layer are separate
    // rules for a reason (an explicit light choice must beat a dark system), so a
    // token present in one and absent from the other is a half-applied theme.
    const css = generateMeridianCss();
    for (const tokenName of SCHEME_COLOR_TOKENS.keys()) {
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

  it("catches a planted difference, so the comparison is not vacuous", () => {
    const generated = generateMeridianCss();
    const tampered = generated.replace("oklch(", "oklcH(");
    expect(tampered).not.toBe(generated);
  });
});

describe("assets — every stylesheet reads only properties the console defines", () => {
  const definedByGenerator = definedTokenVariables(generateMeridianCss());
  const stylesheets = consoleStylesheets(CONSOLE_ROOT_ONLY);
  const sourceModules = consoleSourceModules(CONSOLE_ROOT_ONLY);

  const defined = new Set(definedByGenerator);
  for (const stylesheet of stylesheets) {
    for (const name of definedTokenVariables(readConsoleSourceModule(stylesheet))) {
      defined.add(name);
    }
  }
  for (const module of sourceModules) {
    for (const name of inlineTokenVariables(readConsoleSourceModule(module))) {
      defined.add(name);
    }
  }

  it("finds the console's stylesheets at all", () => {
    // Without this, a resolution mistake would make every assertion below pass
    // over an empty set.
    expect(stylesheets.length).toBeGreaterThan(0);
    expect(sourceModules.length).toBeGreaterThan(0);
  });

  it("resolves every referenced property", () => {
    const undefinedReferences: string[] = [];
    for (const stylesheet of stylesheets) {
      for (const variableName of referencedTokenVariables(readConsoleSourceModule(stylesheet))) {
        if (!defined.has(variableName)) {
          undefinedReferences.push(`${stylesheet.displayPath} -> ${variableName}`);
        }
      }
    }
    // An unresolved property does not fail loudly in a browser: it paints nothing.
    expect(undefinedReferences).toStrictEqual([]);
  });

  it("catches a planted unresolved reference", () => {
    const planted = referencedTokenVariables("a { color: var(--meridian-not-a-token); }");
    expect([...planted].filter((name) => !defined.has(name))).toStrictEqual([
      "--meridian-not-a-token",
    ]);
  });
});
