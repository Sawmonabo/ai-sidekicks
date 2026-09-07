// The cross-family class-name census, pinned.
//
// WHAT THIS GATE IS FOR. A class name declared by two families is styled by whichever
// sheet the bundler emits last, and that order follows the import graph. So the rendered
// shape of a pane can depend on a family it does not import, and the dependency is
// invisible: neither family's CSS says anything, and no test fails until a module moves
// between chunks and takes a sheet's position in the cascade with it.
//
// THE LIVE INSTANCE THAT PAID FOR THIS FILE. `runs/pane/runs.css` declares
// `.meridian-run-controls { flex-direction: column }` and the WORKFLOWS run pane wore
// that class. Moving the runs pane's body behind a loader took the runs sheet off the
// initial graph, and the workflows run pane — untouched, in a family whose files were
// not in the diff — went from a stacked control strip to a side-by-side one: its capture
// changed from 1440x1751 to 1440x1172. That pair is RESOLVED: the workflows block is
// `.meridian-workflow-run-controls` now, so the class the runs sheet declares is the runs
// family's alone and no bundle boundary decides how either surface looks.
//
// A PIN AND NOT A BAN, for a reason the pin itself records. Five collisions are still
// live. Resolving one means renaming a class, and every committed screenshot reference
// that shows the styled element is a picture of the current cascade — so a resolution
// comes with regenerating references on the baseline host. Until then the five are named
// here, and a sixth is a failure. The comparison is EQUALITY rather than containment, so
// resolving one is also a failure until its line is removed: a pin that only grows is a
// pin nobody trims.

import { describe, expect, it, vi } from "vitest";

import {
  consoleStylesheetTexts,
  crossFamilyCollisions,
  formatCollision,
  type StylesheetText,
} from "./stylesheet-selector-owners.js";
import { declaredClassNames, selectorPreludes } from "./stylesheet-selectors.js";

/** Reading and scanning 66 sheets, measured at ~60ms on the authoring machine. */
vi.setConfig({ testTimeout: 20_000 });

/**
 * Every cross-family collision in the tree today, as `className: families`.
 *
 * Each line is debt with a known shape. The surviving `runs, workflows` line is the run
 * LIST's — `workflows/runs/run-list.css` and `runs/pane/runs.css` both declare
 * `.meridian-run-row__failure` — and it is what still holds both runs sheets at that
 * family's door; the `frame, primitives` and `primitives, repos` and
 * `primitives, workflows` lines are a family restating a primitive's class instead of
 * composing it, which is the same hazard with a shorter fuse because `primitives` is
 * imported by nearly everything.
 */
const PINNED_CROSS_FAMILY_COLLISIONS: readonly string[] = [
  "meridian-choice-list: frame, primitives",
  "meridian-choice-list__choice: frame, primitives",
  "meridian-figure--wire: primitives, repos",
  "meridian-refusal--inline: primitives, workflows",
  "meridian-run-row__failure: runs, workflows",
];

/**
 * The floor the census has to clear to be believed.
 *
 * A reader that returned nothing would satisfy the collision claim perfectly, which is
 * the failure mode a pinned-empty-set gate has and cannot see. 993 class names were
 * declared across 66 sheets when this was written; the floor is set well under that so
 * ordinary authoring does not trip it and a broken scan does.
 */
const DECLARED_CLASS_NAME_FLOOR = 700;

/** A stylesheet built in memory, for the planted cases. */
function plantedSheet(family: string, source: string): StylesheetText {
  return { family, displayPath: `console/${family}/planted.css`, source };
}

describe("the console's cross-family class-name census", () => {
  it("declares no class name from two families beyond the pinned set", () => {
    const collisions = crossFamilyCollisions(consoleStylesheetTexts()).map(formatCollision);
    expect(collisions).toStrictEqual(PINNED_CROSS_FAMILY_COLLISIONS);
  });

  // The positive control. Without it, a scan that read no selectors at all would report
  // an empty collision set and pass every claim above.
  it("reads class names out of the real stylesheets", () => {
    const declared = new Set<string>();
    for (const sheet of consoleStylesheetTexts()) {
      for (const className of declaredClassNames(sheet.source)) {
        declared.add(className);
      }
    }
    expect(declared.size).toBeGreaterThan(DECLARED_CLASS_NAME_FLOOR);
    expect(declared.has("meridian-run-controls")).toBe(true);
    // Its resolved counterpart, so the positive control also names the rename this pin
    // was trimmed for: both blocks exist, under two names, in two families.
    expect(declared.has("meridian-workflow-run-controls")).toBe(true);
  });
});

describe("the collision reader, against planted stylesheets", () => {
  // The planted failure: the exact shape the runs/workflows pair has.
  it("reports a class two families declare", () => {
    const collisions = crossFamilyCollisions([
      plantedSheet("runs", ".meridian-planted-control { flex-direction: column; }"),
      plantedSheet("workflows", ".meridian-planted-control { flex-direction: row; }"),
    ]);
    expect(collisions.map(formatCollision)).toStrictEqual([
      "meridian-planted-control: runs, workflows",
    ]);
  });

  // The other half, and the reason ownership is keyed on the family rather than the
  // file: a family splitting a class across two of its own sheets loads them in its own
  // import order, which that family decides.
  it("reports nothing when one family declares a class in two of its sheets", () => {
    expect(
      crossFamilyCollisions([
        plantedSheet("runs", ".meridian-planted-control { color: red; }"),
        plantedSheet("runs", ".meridian-planted-control { color: blue; }"),
      ]),
    ).toStrictEqual([]);
  });

  // A mention is not a declaration. Both forms were live in the tree when this was
  // written: sheets name other families' classes in comments to explain a composition,
  // and declaration values carry dotted text.
  it("mints no owner from a comment or a declaration value", () => {
    const sheets = [
      plantedSheet("runs", "/* pairs with .meridian-planted-control */ .runs-only { top: 0; }"),
      plantedSheet(
        "workflows",
        '.workflows-only { transition: transform .2s; content: ".meridian-planted-control"; }',
      ),
    ];
    expect(crossFamilyCollisions(sheets)).toStrictEqual([]);
    expect(declaredClassNames(sheets[1]?.source ?? "")).toStrictEqual(new Set(["workflows-only"]));
  });

  // Nested rules are reached, so a collision cannot hide inside a media query.
  it("reads selectors nested inside an at-rule", () => {
    const collisions = crossFamilyCollisions([
      plantedSheet("runs", "@media (min-width: 40rem) { .meridian-planted-control { top: 0; } }"),
      plantedSheet("workflows", ".meridian-planted-control { top: 1px; }"),
    ]);
    expect(collisions.map(formatCollision)).toStrictEqual([
      "meridian-planted-control: runs, workflows",
    ]);
  });

  it("drops the at-rule prelude itself rather than reading it as a selector", () => {
    expect(selectorPreludes("@import url(x.css);\n@media print { .a { top: 0; } }")).toStrictEqual([
      ".a",
    ]);
  });
});
