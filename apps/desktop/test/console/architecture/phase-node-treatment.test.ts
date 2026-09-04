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

import { readConsoleFile } from "./stylesheet-edge-graph.js";

const PHASE_GRAPH_STYLESHEET = "panes/workflow-run/phase-graph/phase-graph.css";

/** Every accent token this console publishes, so a rule cannot reach for a variant. */
const ACCENT_TOKENS: readonly string[] = [
  "--meridian-accent",
  "--meridian-accent-text",
  "--meridian-accent-ink",
  "--meridian-accent-pressed",
];

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

describe("the phase node's state treatment", () => {
  const stylesheet = readConsoleFile(PHASE_GRAPH_STYLESHEET);
  const blocks = stateScopedBlocks(stylesheet);

  it("matched the state rules it is making a claim about", () => {
    // The tripwire's own zero-match guard. A regular expression that stopped matching
    // would make every assertion below vacuously true.
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    expect(blocks.map((block) => block.selector).join(" ")).toContain('[data-state="running"]');
  });

  it("gives no phase state an accent token, the running one included", () => {
    const spending = blocks.filter((block) =>
      ACCENT_TOKENS.some((token) => block.body.includes(token)),
    );
    expect(spending.map((block) => block.selector)).toStrictEqual([]);
  });

  it("negative control: the sheet still carries accent tokens outside the state rules", () => {
    // Without this the case above would pass over a stylesheet that had dropped the
    // accent everywhere, which is a different change and would not be caught.
    expect(stylesheet).toContain("--meridian-accent");
  });

  it("negative control: the same check finds an accent planted in a state rule", () => {
    // The checker driven against a known-bad sheet, so a clean result is evidence.
    const planted = stylesheet.replace(
      '.meridian-phase-node[data-state="running"] {',
      '.meridian-phase-node[data-state="running"] {\n  outline-color: var(--meridian-accent);',
    );
    expect(planted).not.toBe(stylesheet);
    const spending = stateScopedBlocks(planted).filter((block) =>
      ACCENT_TOKENS.some((token) => block.body.includes(token)),
    );
    expect(spending.map((block) => block.selector)).toStrictEqual([
      '.meridian-phase-node[data-state="running"]',
    ]);
  });
});
