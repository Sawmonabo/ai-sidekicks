// What `feature-mounts/schema-form.tsx`'s three readings answer, over documents a mount cannot
// be asked to produce.
//
// React renders an ARIA attribute as a string, so a control rendered with `aria-busy={false}`
// carries the literal `aria-busy="false"`. An unscoped `[aria-busy]` read would call it "the
// compiler has not arrived yet" and hang the mount under a message naming a compiler that had
// landed; the readings are scoped to the form instead.
//
// The inputs are built here because no scenario mounts a settled `aria-busy="false"` control
// without a form, or a form carrying that attribute (a settled form renders `undefined`). The
// readings are the real ones, imported from the module the mounts use. The cases build detached
// documents and mount nothing; the file is in the browser tier because the module under test
// mounts through `app-harness.ts`.

import { describe, expect, it } from "vitest";

import {
  holdsSchemaForm,
  isSchemaFormSettled,
  schemaFormIsAwaitingCompiler,
} from "../helpers/feature-mounts/schema-form.js";

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
    // The shape an unscoped read gets wrong. The loose selector does match here (asserted below),
    // so a predicate not scoped to the form would report a compiler still arriving in a region
    // with no schema form.
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
    // The form renders `aria-busy={undefined}` once the validator has a verdict, so the attribute
    // is absent rather than `"false"`; a different document from the case above.
    const region = regionHolding(
      `<form class="meridian-schema-answer"><button>Submit answer</button></form>`,
    );
    expect(holdsSchemaForm(region)).toBe(true);
    expect(schemaFormIsAwaitingCompiler(region)).toBe(false);
    expect(isSchemaFormSettled(region)).toBe(true);
  });

  it("holds a form that says it is not busy to be waiting anyway", () => {
    // The one shape presence-matching and value-matching disagree on. The form does not draw it
    // today; if it ever does, presence keeps a caller waiting to its deadline and fails loudly,
    // while a value match would let a tier audit a form still compiling.
    const region = regionHolding(
      `<form class="meridian-schema-answer" aria-busy="false"><button>Submit answer</button></form>`,
    );
    expect(holdsSchemaForm(region)).toBe(true);
    expect(schemaFormIsAwaitingCompiler(region)).toBe(true);
    expect(isSchemaFormSettled(region)).toBe(false);
  });
});
