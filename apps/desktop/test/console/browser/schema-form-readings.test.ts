// What `surfaces/schema-form.tsx`'s three readings answer, over the documents a mount
// cannot be asked to produce.
//
// THE DEFECT THEY PIN. The workflows family's parked-run mount read
// `region.querySelector("[aria-busy]")` — unscoped — and called a match "the compiler
// has not arrived yet". React renders an ARIA attribute as a STRING, so a control
// rendered with `aria-busy={false}` is the literal `aria-busy="false"` in the document
// and that selector matches it. Nothing in that pane draws one today, which is exactly
// what makes it worth pinning: the read was true by coincidence rather than by rule, and
// the first control the pane grows with a busy state it is not currently in would have
// hung the mount until it timed out, under a message naming a compiler that had landed
// long before. A mount that waits for the wrong thing does not fail loudly — it fails as
// a tier that got slower and then, once, as a reference minted from a half-drawn pane.
//
// WHY THE INPUTS ARE BUILT HERE. The readings' subjects are shapes the fixture cannot be
// asked to produce: no scenario mounts a pane holding a settled `aria-busy="false"`
// control and no form, and none mounts a FORM carrying that attribute at all, since the
// seat renders `undefined` on its settled arm. A fixture written to produce either would
// be a fixture written to satisfy this file rather than to describe the product. The
// readings themselves are the real ones, imported from the module the mounts use — a
// local re-reading of the selector would prove nothing about either wait.
//
// WHY THIS TIER. The module under test mounts a React seat through `console-harness.tsx`
// and reaches the console's own barrels, so it belongs to a browser-mode project rather
// than a Node one — and this is the project whose glob claims a `test/console/browser/`
// file, and whose neighbours already drive that mount. The cases below build detached
// documents and mount nothing, which is what lets them state the shapes a mount cannot.

import { describe, expect, it } from "vitest";

import {
  holdsSchemaForm,
  isSchemaFormSettled,
  schemaFormIsAwaitingCompiler,
} from "../surfaces/schema-form.js";

/** Build one detached region from markup, the way the pane's own DOM would read. */
function regionHolding(markup: string): HTMLElement {
  const region = document.createElement("section");
  region.innerHTML = markup;
  return region;
}

describe("the schema form's own busy state", () => {
  it("reports a form whose compiler is still in flight", () => {
    const region = regionHolding(
      `<form class="meridian-schema-answer" aria-busy="true"><button disabled>Submit answer</button></form>`,
    );
    expect(holdsSchemaForm(region)).toBe(true);
    expect(schemaFormIsAwaitingCompiler(region)).toBe(true);
    expect(isSchemaFormSettled(region)).toBe(false);
  });

  it("does not report a settled control that says it is not busy", () => {
    // The shape the old read got wrong, and the assertion below it is what makes this
    // a control rather than a restatement: the superseded selector DOES match here, so
    // a predicate that had not been scoped to the form would report a compiler still
    // arriving in a region that holds no schema form at all.
    const region = regionHolding(
      `<button class="meridian-run-control" aria-busy="false">Resume</button>`,
    );
    expect(
      region.querySelector("[aria-busy]"),
      "the superseded loose read no longer matches this region, so it is not the shape this case exists for",
    ).not.toBeNull();
    expect(holdsSchemaForm(region)).toBe(false);
    expect(schemaFormIsAwaitingCompiler(region)).toBe(false);
    expect(isSchemaFormSettled(region)).toBe(false);
  });

  it("does not report a form that has its compiler", () => {
    // The seat renders `aria-busy={undefined}` once the validator has a verdict, so the
    // attribute is absent rather than `"false"` — asserted separately from the case
    // above because the two are different documents and only one of them is the seat's.
    const region = regionHolding(
      `<form class="meridian-schema-answer"><button>Submit answer</button></form>`,
    );
    expect(holdsSchemaForm(region)).toBe(true);
    expect(schemaFormIsAwaitingCompiler(region)).toBe(false);
    expect(isSchemaFormSettled(region)).toBe(true);
  });

  it("holds a form that says it is not busy to be waiting anyway", () => {
    // The one shape the two candidate rules disagree on, pinned so the choice between
    // them is checkable rather than a paragraph. The seat does not draw this today; if
    // it ever does, presence keeps a caller waiting to its deadline and fails loudly,
    // while a value match would return and let a tier audit a form still compiling.
    const region = regionHolding(
      `<form class="meridian-schema-answer" aria-busy="false"><button>Submit answer</button></form>`,
    );
    expect(holdsSchemaForm(region)).toBe(true);
    expect(schemaFormIsAwaitingCompiler(region)).toBe(true);
    expect(isSchemaFormSettled(region)).toBe(false);
  });
});
