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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CONSOLE_SCHEMES,
  PARTICIPANT_HUES,
  SCHEME_COLOR_TOKENS,
  formatOklch,
  generateMeridianCss,
  participantHueTokenName,
  tokenVariableName,
} from "../../../src/renderer/src/console/tokens/index.js";

const CONSOLE_ROOT = fileURLToPath(new URL("../../../src/renderer/src/console", import.meta.url));

/** Console files with one of these extensions, found rather than listed. */
function consoleFilePaths(directory: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...consoleFilePaths(path, extensions));
    } else if (extensions.some((extension) => entry.endsWith(extension))) {
      found.push(path);
    }
  }
  return found;
}

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

  it("catches a planted difference, so the comparison is not vacuous", () => {
    const generated = generateMeridianCss();
    const tampered = generated.replace("oklch(", "oklcH(");
    expect(tampered).not.toBe(generated);
  });
});

describe("assets — every stylesheet reads only properties the console defines", () => {
  const definedByGenerator = definedTokenVariables(generateMeridianCss());
  const stylesheetPaths = consoleFilePaths(CONSOLE_ROOT, [".css"]);
  const sourcePaths = consoleFilePaths(CONSOLE_ROOT, [".ts", ".tsx"]);

  const defined = new Set(definedByGenerator);
  for (const path of stylesheetPaths) {
    for (const name of definedTokenVariables(readFileSync(path, "utf8"))) {
      defined.add(name);
    }
  }
  for (const path of sourcePaths) {
    for (const name of inlineTokenVariables(readFileSync(path, "utf8"))) {
      defined.add(name);
    }
  }

  it("finds the console's stylesheets at all", () => {
    // Without this, a resolution mistake would make every assertion below pass
    // over an empty set.
    expect(stylesheetPaths.length).toBeGreaterThan(0);
    expect(sourcePaths.length).toBeGreaterThan(0);
  });

  it("resolves every referenced property", () => {
    const undefinedReferences: string[] = [];
    for (const path of stylesheetPaths) {
      const css = readFileSync(path, "utf8");
      for (const variableName of referencedTokenVariables(css)) {
        if (!defined.has(variableName)) {
          undefinedReferences.push(`${path.slice(CONSOLE_ROOT.length + 1)} -> ${variableName}`);
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
