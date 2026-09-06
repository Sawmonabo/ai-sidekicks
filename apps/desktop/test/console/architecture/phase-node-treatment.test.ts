// What the phase graph's node treatment is allowed to spend the accent on, which is
// nothing.
//
// `Spec-023 §Console Design (Meridian)` rule 3 and `tokens/palette.ts` put the console's
// one accent on interactive affordances. The phase canvas is read-only by construction —
// `PhaseGraphCanvas.tsx` switches off dragging, connecting, selecting, reconnecting,
// deleting and keyboard node movement — so a node's own state treatment can carry no
// accent token at all, and a `running` phase carried two.
//
// A SOURCE-TEXT CLAIM, IN THE ARCHITECTURE TIER, because that is where the rule lives:
// jsdom applies no stylesheet, and a rendered-DOM assertion would say which class is on
// the box rather than which colour the sheet gives it. The tier already reads console
// files by name for the stylesheet-edge claims and this reuses that reader rather than
// opening a second path to the same tree.

import { describe, expect, it } from "vitest";

import {
  SCHEME_COLOR_TOKENS,
  tokenVariableName,
} from "../../../src/renderer/src/console/tokens/tokens.js";
import { readConsoleFile } from "./stylesheet-edge-graph.js";

const PHASE_GRAPH_STYLESHEET = "workflows/pane/run/phase-graph/phase-graph.css";

/**
 * The accent custom-property names, derived from the palette rather than restated.
 *
 * `SCHEME_COLOR_TOKENS` is every colour token the console publishes across all three
 * palette groups, and `tokenVariableName()` is the one function that turns a token name
 * into the custom property a stylesheet writes. Listing the four names here instead —
 * which is what this file did — declared a closed set twice, and the copy could not go
 * stale loudly: adding `accent-muted` to `tokens/palette.ts` would have left this
 * asserting over four names while a node styled with the fifth passed a gate whose
 * whole claim is that phase nodes spend no accent.
 *
 * A prefix match on the derived name, not on the token key, because the prefix is what
 * a stylesheet actually contains. `focus-ring` is deliberately not here: it is the
 * ring's own token and the canvas turns off the affordance that would draw it.
 *
 * The set is matched against the properties a block REFERENCES rather than searched for
 * as substrings of the block, which is what makes it load-bearing. Under a substring
 * search every member but `--meridian-accent` was redundant — each of the others has it
 * as a prefix — so the four-name list could have been one name and a palette addition
 * would have been caught either way. Exact membership is also the truer predicate: a
 * custom property the palette does not publish is not a token and resolves to nothing.
 */
function accentTokensAmong(colorTokenNames: Iterable<string>): readonly string[] {
  const accentPrefix = tokenVariableName("accent");
  return [...colorTokenNames]
    .map((tokenName) => tokenVariableName(tokenName))
    .filter((variable) => variable === accentPrefix || variable.startsWith(`${accentPrefix}-`));
}

const ACCENT_TOKENS: readonly string[] = accentTokensAmong(SCHEME_COLOR_TOKENS.keys());

/**
 * Every declaration block whose selector names one phase state, with its selector.
 *
 * Selector-scoped rather than a whole-file grep: the sheet legitimately hands the
 * library's own selection, connection-line and resize variables the accent, and those
 * are the affordances the canvas turns off rather than treatments it paints on a node.
 * A test that banned the token from the file would be asserting a different rule.
 */
function stateScopedBlocks(stylesheet: string): readonly { selector: string; body: string }[] {
  const blocks: { selector: string; body: string }[] = [];
  // Comments first: this sheet documents each rule above it, a comment carries no
  // brace, and a selector capture that ran through one would report the prose as part
  // of the selector it explains.
  const declarations = stylesheet.replaceAll(/\/\*[\s\S]*?\*\//gu, "");
  const rule = /(?<selector>[^{}]*\[data-state="[^"]+"\][^{}]*)\{(?<body>[^{}]*)\}/gu;
  for (const match of declarations.matchAll(rule)) {
    const { selector, body } = match.groups ?? {};
    if (selector !== undefined && body !== undefined) {
      blocks.push({ selector: selector.trim(), body });
    }
  }
  return blocks;
}

/** Every Meridian custom property a declaration block references, in source order. */
function referencedTokenVariables(body: string): readonly string[] {
  return [...body.matchAll(/--meridian-[a-z\d-]+/gu)].map((match) => match[0]);
}

/** The state rules that spend an accent, which is the whole of the claim here. */
function blocksSpendingAccent(
  blocks: readonly { selector: string; body: string }[],
): readonly string[] {
  return blocks
    .filter((block) =>
      referencedTokenVariables(block.body).some((variable) => ACCENT_TOKENS.includes(variable)),
    )
    .map((block) => block.selector);
}

describe("the phase node's state treatment", () => {
  const stylesheet = readConsoleFile(PHASE_GRAPH_STYLESHEET);
  const blocks = stateScopedBlocks(stylesheet);

  it("derived the accent set off the palette, and found the accents that are in it", () => {
    // The derivation's own zero-match guard. A filter that stopped matching — a renamed
    // palette key, a changed prefix, a token group dropped from `SCHEME_COLOR_TOKENS` —
    // would ban nothing and make every assertion below vacuously true.
    //
    // Deliberately NOT the four names spelled out: that is the hand-written closed set
    // this derivation exists to retire, and pinning it here would put it back and make
    // every legitimate palette addition fail a test about phase nodes. What is pinned
    // is that the filter admits the token the palette certainly has, and admits nothing
    // that is not an accent.
    expect(ACCENT_TOKENS).toContain(tokenVariableName("accent"));
    expect(
      ACCENT_TOKENS.filter((variable) => !variable.startsWith(tokenVariableName("accent"))),
    ).toStrictEqual([]);
  });

  it("negative control: a palette addition joins the assertion rather than escaping it", () => {
    // The finding's own counterexample, driven against a foil: a fifth accent in the
    // palette is a fifth name here without an edit. Against the hand-written list this
    // file used to carry, the same addition changed nothing and the new token stayed
    // spendable.
    const withAnotherAccent = [...SCHEME_COLOR_TOKENS.keys(), "accent-muted"];

    expect(accentTokensAmong(withAnotherAccent)).toContain(tokenVariableName("accent-muted"));
    expect(accentTokensAmong(withAnotherAccent)).toHaveLength(ACCENT_TOKENS.length + 1);
  });

  it("matched the state rules it is making a claim about", () => {
    // The tripwire's own zero-match guard. A regular expression that stopped matching
    // would make every assertion below vacuously true.
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    expect(blocks.map((block) => block.selector).join(" ")).toContain('[data-state="running"]');
  });

  it("gives no phase state an accent token, the running one included", () => {
    expect(blocksSpendingAccent(blocks)).toStrictEqual([]);
  });

  it("negative control: the sheet still carries accent tokens outside the state rules", () => {
    // Without this the case above would pass over a stylesheet that had dropped the
    // accent everywhere, which is a different change and would not be caught.
    expect(stylesheet).toContain("--meridian-accent");
  });

  it.each(["accent", "accent-pressed"])(
    "negative control: the same check finds `%s` planted in a state rule",
    (tokenName) => {
      // The checker driven against a known-bad sheet, so a clean result is evidence —
      // and driven with a derived member that is NOT the base accent, so every name the
      // palette contributes is load-bearing rather than shadowed by the first one.
      const planted = stylesheet.replace(
        '.meridian-phase-node[data-state="running"] {',
        `.meridian-phase-node[data-state="running"] {\n  outline-color: var(${tokenVariableName(tokenName)});`,
      );
      expect(planted).not.toBe(stylesheet);

      expect(blocksSpendingAccent(stateScopedBlocks(planted))).toStrictEqual([
        '.meridian-phase-node[data-state="running"]',
      ]);
    },
  );
});
