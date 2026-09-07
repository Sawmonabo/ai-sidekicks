// One grammar, proved once and then proved to be the one BOTH stylesheet gates read.
//
// THE FIRST HALF is ordinary: the brace scan and the class-token pattern, over the shapes
// real console sheets carry — a comment holding a brace, a declaration value holding a
// dot, a rule nested in an at-rule.
//
// THE SECOND HALF IS THE CONTROL THAT MADE THIS MODULE WORTH HOISTING. The collision
// census and the chunk-root placement census each used to carry their own copy of this
// reading. Two copies of one grammar do not fail together: a correction landing in one
// makes the two censuses disagree about what a sheet declares, and the disagreement is
// SILENT — the placement gate reports an offence on finding NO user, so the copy that
// reads one class too many quietly exonerates a misplaced sheet while the collision
// census, reading correctly, says nothing about placement at all.
//
// So the control feeds ONE fixture through BOTH gates' real entry points and asserts the
// outcome each of them owns. The fixture is the shape that separates the grammars: a
// comment that contains a `{` and MENTIONS a class the sheet does not declare. Read
// correctly the mention is nothing; read without the comment strip it becomes a
// declaration, which mints a false collision on one gate and cancels a true offence on
// the other. Re-copy the parser into either gate and one of the two cases below goes red.

import { describe, expect, it } from "vitest";

import { syntheticStylesheetTree } from "./stylesheet-edge-graph.js";
import { crossFamilyCollisions, type StylesheetText } from "./stylesheet-selector-owners.js";
import { declaredClassNames, selectorPreludes } from "./stylesheet-selectors.js";
import { deferredSheetOffences } from "./stylesheet-static-reach.js";

/** The class the fixture sheet declares. */
const OWNED_CLASS = "meridian-planted-owned";

/** The class the fixture sheet only MENTIONS, inside a comment that also holds a brace. */
const MENTIONED_CLASS = "meridian-planted-mentioned";

/**
 * The fixture both gates are asked about.
 *
 * The comment is written the way console sheets actually write them — naming the selector
 * a rule pairs with — and it carries an opening brace, which is what a scan that did not
 * strip comments first would read as the start of a rule whose prelude names the
 * mentioned class.
 */
const COMMENT_MENTION_SHEET = `/* pairs with .${MENTIONED_CLASS} { … } in the family sheet */
.${OWNED_CLASS} {
  top: 0;
}
`;

/** A stylesheet as the collision census reads one: family, path, text. */
function plantedSheet(family: string, source: string): StylesheetText {
  return { family, displayPath: `console/${family}/planted.css`, source };
}

describe("the stylesheet selector grammar", () => {
  it("reads the class out of a rule's prelude and nothing out of its body", () => {
    expect(declaredClassNames(".meridian-a { color: red; }")).toStrictEqual(
      new Set(["meridian-a"]),
    );
  });

  it("reads no class out of a comment, whatever the comment contains", () => {
    expect(declaredClassNames(COMMENT_MENTION_SHEET)).toStrictEqual(new Set([OWNED_CLASS]));
  });

  it("reads no class out of a declaration value carrying dotted text", () => {
    expect(
      declaredClassNames('.meridian-a { transition: transform .2s; content: ".meridian-b"; }'),
    ).toStrictEqual(new Set(["meridian-a"]));
  });

  it("reaches a rule nested inside an at-rule and drops the at-rule's own prelude", () => {
    expect(selectorPreludes("@media (min-width: 40rem) { .meridian-a { top: 0; } }")).toStrictEqual(
      [".meridian-a"],
    );
  });
});

describe("the one grammar, read through both gates that ask for it", () => {
  // The collision census's own entry point. A comment-blind parser would report the
  // mentioned class as declared by the family that only names it, and mint a collision
  // between two families where exactly one declares anything.
  it("mints no collision from a class one family only mentions", () => {
    expect(
      crossFamilyCollisions([
        plantedSheet("runs", COMMENT_MENTION_SHEET),
        plantedSheet("workflows", `.${MENTIONED_CLASS} { top: 1px; }`),
      ]),
    ).toStrictEqual([]);
  });

  // The placement census's own entry point, over the same fixture. The door's static
  // graph names ONLY the mentioned class, so the sheet it imports is unusable by anything
  // that door reaches and the offence has to stand. A comment-blind parser would count
  // the mention as declared, find the door's token matching it, and cancel the offence —
  // which is the silent direction: a misplaced sheet passing a gate that exists for it.
  it("keeps the offence a comment-blind parser would cancel", () => {
    const tree = syntheticStylesheetTree(
      new Map([
        [
          "planted/index.ts",
          'import "./pane/pane.css";\nimport { mention } from "./mention.js";\nexport const register = () => [mention, import("./pane/planted-pane-body.js")];\n',
        ],
        // Statically reachable from the door, and it names the MENTIONED class — which is
        // the half that makes this case discriminate. Read correctly the sheet declares no
        // such class, so this token matches nothing and the offence stands; read without
        // the comment strip the sheet declares it, this token matches, and the gate
        // reports the misplaced sheet as perfectly placed.
        ["planted/mention.ts", `export const mention = "${MENTIONED_CLASS}";\n`],
        // The sheet's only real reader, behind the `import()` — which is what makes the
        // sheet misplaced in the first place.
        ["planted/pane/planted-pane-body.ts", `export const Body = () => "${OWNED_CLASS}";\n`],
        ["planted/pane/pane.css", COMMENT_MENTION_SHEET],
      ]),
    );
    const offences = deferredSheetOffences(
      tree,
      () => "planted/index.ts",
      () => false,
      () => false,
    );
    expect(offences.map((offence) => offence.stylesheetPath)).toStrictEqual([
      "planted/pane/pane.css",
    ]);
  });
});
