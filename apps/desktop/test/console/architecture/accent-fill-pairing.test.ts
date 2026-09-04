// The on-accent pairing, asserted where a stylesheet cannot import anything.
//
// `Spec-023 §Console Design (Meridian)` rule 3 puts a 4.5:1 floor under every
// label, and `accent-text` is the accent-tinted ink for text on a NEUTRAL ground.
// Painting it on the `accent` fill measures 1.53:1 in light and 1.48:1 in dark —
// a pairing that looks deliberate in a diff, reads as "the accent colours" to
// whoever writes it, and is caught by nothing: `tokens/contrast.test.ts` measures
// the pairs the palette DECLARES, and a pair a stylesheet invents by putting two
// tokens in one block is not one of them.
//
// So this file checks the two halves that no other gate reaches.
//
//   1. `primitives/accent-fill.ts` names a class, and a name is only worth having
//      if the sheet defines it. Nothing else can check that edge: TypeScript sees
//      the constant and CSS sees the selector, and neither sees the other.
//   2. No stylesheet pairs `accent-text` with the `accent` fill in one block. The
//      one filled-accent treatment the console owns is `.meridian-accent-fill`,
//      whose ink is `accent-ink` and whose pair IS measured.
//
// The scan is over the whole renderer rather than `console/` alone: `shell/` holds
// composer styles written against the same tokens, and a rule the console would
// refuse is not made acceptable by living one directory up.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The leaf rather than the family door: the door imports the stylesheet and every
// component behind it, and this tier runs under `node` with no DOM to render them
// into. The constant is the whole subject here.
import { ACCENT_FILL_CLASS } from "../../../src/renderer/src/console/primitives/accent-fill.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDERER_DIRECTORY = resolve(HERE, "..", "..", "..", "src", "renderer", "src");
const PRIMITIVES_SHEET = join("console", "primitives", "primitives.css");

/** One declaration block: what it selects, and what it declares. */
interface StyleRule {
  readonly selector: string;
  readonly body: string;
}

/**
 * The declaration blocks in one stylesheet.
 *
 * A pure function over text so the negative controls below can drive it with
 * strings whose verdict is known, rather than proving the checker bites by
 * perturbing a real sheet. Comments are stripped first: this file's own prose
 * quotes the pairing it forbids, and a checker that read comments would flag the
 * documentation of the rule as a violation of it.
 */
function styleRules(sheet: string): readonly StyleRule[] {
  const declarations = sheet.replaceAll(/\/\*[\s\S]*?\*\//gu, "");
  const rules: StyleRule[] = [];
  for (const chunk of declarations.split("}")) {
    const bodyStart = chunk.lastIndexOf("{");
    if (bodyStart === -1) {
      continue;
    }
    const selector = chunk.slice(0, bodyStart).trim().replaceAll(/\s+/gu, " ");
    const body = chunk.slice(bodyStart + 1);
    if (selector === "" || body.trim() === "") {
      continue;
    }
    rules.push({ selector, body });
  }
  return rules;
}

/**
 * The accent FILL as a ground. `background: var(--meridian-accent)` exactly — not
 * `accent-pressed`, which is a different token with its own measured pair, and not
 * a border, which carries no text.
 */
const ACCENT_GROUND = /(?:^|[;\s])background(?:-color)?:\s*var\(--meridian-accent\)/u;

/**
 * `accent-text` as the INK. The leading boundary is load-bearing: without it
 * `border-color: var(--meridian-accent-text)` matches, and a boundary is not a
 * label.
 */
const ACCENT_TEXT_INK = /(?:^|[;\s])color:\s*var\(--meridian-accent-text\)/u;

/** The selectors in `sheet` that put `accent-text` on the accent fill, or `[]`. */
function accentTextOnAccentFill(sheet: string): readonly string[] {
  return styleRules(sheet)
    .filter((rule) => ACCENT_GROUND.test(rule.body) && ACCENT_TEXT_INK.test(rule.body))
    .map((rule) => rule.selector);
}

function rendererStylesheets(): readonly string[] {
  return readdirSync(RENDERER_DIRECTORY, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".css"))
    .sort();
}

function readStylesheet(sheet: string): string {
  return readFileSync(join(RENDERER_DIRECTORY, sheet), "utf8");
}

describe("accent-fill — the one filled-accent face, and the pairing it replaces", () => {
  const stylesheets = rendererStylesheets();

  it("finds a renderer stylesheet tree to scan at all", () => {
    // Without this, a wrong RENDERER_DIRECTORY would scan nothing and the clean
    // result below would be a claim about the empty set.
    expect(stylesheets.length).toBeGreaterThan(5);
    expect(stylesheets).toContain(PRIMITIVES_SHEET);
  });

  it("defines the class the primitives export names", () => {
    const selectors = styleRules(readStylesheet(PRIMITIVES_SHEET)).map((rule) => rule.selector);
    expect(selectors.some((selector) => selector.includes(`.${ACCENT_FILL_CLASS}`))).toBe(true);
  });

  it("no stylesheet paints accent-text on the accent fill", () => {
    const offenders = stylesheets
      .flatMap((sheet) =>
        accentTextOnAccentFill(readStylesheet(sheet)).map((selector) => `${sheet}: ${selector}`),
      )
      .sort();
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the checker names the pairing when a block carries it", () => {
    // The exact shape the approve action and the goal's save carried before the
    // filled treatment replaced them.
    expect(
      accentTextOnAccentFill(
        ".a { color: var(--meridian-accent-text); background: var(--meridian-accent); }",
      ),
    ).toStrictEqual([".a"]);
  });

  it("negative control: it passes the three pairings that are not the failure", () => {
    // Accent-tinted ink on a SURFACE — what `accent-text` is for.
    expect(
      accentTextOnAccentFill(
        ".a { color: var(--meridian-accent-text); background: var(--meridian-surface); }",
      ),
    ).toStrictEqual([]);
    // The accent as a BOUNDARY beside that ink, which is the composer's primary.
    expect(
      accentTextOnAccentFill(
        ".a { color: var(--meridian-accent-text); border: 1px solid var(--meridian-accent); }",
      ),
    ).toStrictEqual([]);
    // The filled treatment itself: the same ground, with the ink that is measured
    // against it.
    expect(
      accentTextOnAccentFill(
        `.${ACCENT_FILL_CLASS} { background: var(--meridian-accent); color: var(--meridian-accent-ink); }`,
      ),
    ).toStrictEqual([]);
  });
});
