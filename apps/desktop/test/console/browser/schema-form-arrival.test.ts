// What the parked-run mount is actually waiting for when it waits for the schema form.
//
// THE DEFECT THIS PINS. `surfaces/workflows.tsx`' third wait read
// `region.querySelector("[aria-busy]")` and called a match "the compiler has not
// arrived yet". React renders an ARIA attribute as a STRING, so a control rendered
// with `aria-busy={false}` is the literal `aria-busy="false"` in the document and that
// selector matches it. Nothing in that pane draws one today, which is exactly what
// makes it worth pinning: the read was true by coincidence rather than by rule, and the
// first control the pane grows with a busy state it is not currently in would have hung
// the mount until it timed out, under a message naming a compiler that had landed long
// before. A mount that waits for the wrong thing does not fail loudly — it fails as a
// tier that got slower and then, once, as a reference minted from a half-drawn pane.
//
// WHY THE INPUTS ARE BUILT HERE. The readings' subject is a shape the fixture cannot be
// asked to produce: no scenario mounts a pane holding a settled `aria-busy="false"`
// control and no form, and one that could would be a fixture written to satisfy this
// case rather than to describe the product. The readings themselves are the real ones,
// imported from the module the mount uses — a local re-reading of the selector would
// prove nothing about the wait.
//
// WHY THIS TIER, stated as what it is rather than as a capability claim. The module
// under test is a leaf with no browser import at all, so nothing about it needs a real
// page. It is here because no Vitest project claims `test/console/*.test.ts` at the tier
// root — the tier directories are the globs — and this is the cheapest project whose
// glob reaches a file, and the one whose other suites already drive the mount that
// consumes these readings.

import { describe, expect, it } from "vitest";

import { holdsSchemaForm, schemaFormIsAwaitingCompiler } from "../schema-form-arrival.js";

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
  });

  it("does not report a settled control that says it is not busy", () => {
    // The shape the old read got wrong, and the assertion below it is what makes this
    // a control rather than a restatement: the superseded selector DOES match here, so
    // a predicate that had not been narrowed would report a compiler still arriving in
    // a region that holds no schema form at all.
    const region = regionHolding(
      `<button class="meridian-run-control" aria-busy="false">Resume</button>`,
    );
    expect(
      region.querySelector("[aria-busy]"),
      "the superseded loose read no longer matches this region, so it is not the shape this case exists for",
    ).not.toBeNull();
    expect(holdsSchemaForm(region)).toBe(false);
    expect(schemaFormIsAwaitingCompiler(region)).toBe(false);
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
  });
});
