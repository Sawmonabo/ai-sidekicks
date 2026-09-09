// Whether a mounted region holds the schema-form seat, and whether that form is still
// waiting for its compiler.
//
// A TIER-ROOT ROLE RATHER THAN A FAMILY MOUNT, which is why it is here and not inside
// `surfaces/workflows.tsx`. The subject is `seats/schema-form`, not the workflows
// family: the run pane answers a parked phase with it today, the builder previews with
// it, and the input-ask card's structured-options arm is the next reader. A reading of a
// SEAT held inside one family's mount file would be the first of several copies, one per
// family that grows a form — and `surfaces/` is one file per family by its own rule, so
// there is nowhere in it for a reading that belongs to none of them.
//
// THE DEFECT IT REPLACED. The parked-run mount waited on `region.querySelector(
// "[aria-busy]")` and called a match "the compiler has not arrived yet". React renders
// an ARIA attribute as a STRING, so a control rendered with `aria-busy={false}` is the
// literal `aria-busy="false"` in the document and that selector matches it. Nothing in
// that pane draws one today, which is what makes it worth naming: the read was true by
// coincidence rather than by rule, and the first control the pane grows with a busy
// state it is not currently in would have hung the mount until it timed out, under a
// message naming a compiler that had landed long before.
//
// Not a test file — no `include` glob reaches it. `test/console/browser/
// schema-form-arrival.test.ts` drives both readings, including the shape the old one
// got wrong.

/**
 * The class the seat puts on its own `<form>`, read here and set there.
 *
 * A LITERAL rather than an import: this is test scaffolding and the seat's class names
 * are not exported for it, so the alternative is not a shared constant but a production
 * export minted for a wait. What keeps the literal honest is the order a caller asks in
 * — presence first, busy second — so a rename fails a mount by name instead of turning
 * its wait into a condition satisfied the instant it is asked.
 */
const SCHEMA_FORM_SELECTOR = "form.meridian-schema-answer";

/** Whether this region holds the seat's own answer form at all. */
export function holdsSchemaForm(region: ParentNode): boolean {
  return region.querySelector(SCHEMA_FORM_SELECTOR) !== null;
}

/**
 * Whether this region holds a schema form whose compiler has not landed.
 *
 * SCOPED TO THE FORM AND TO `"true"`, and both halves of that are the fix — the header
 * above says what the loose read matched. The seat's own form renders `undefined` on its
 * settled arm rather than `false`, so the attribute is absent there; that is the seat's
 * choice today and not something a waiter may rest on, which is why the value is
 * matched rather than the attribute's presence.
 *
 * A named function rather than a line inside a `waitFor`, so the negative control can
 * drive it: a region with an `aria-busy="false"` control and no form is exactly the
 * shape the old read got wrong, and it is not a shape a fixture mount can be asked to
 * produce on demand.
 */
export function schemaFormIsAwaitingCompiler(region: ParentNode): boolean {
  return region.querySelector(`${SCHEMA_FORM_SELECTOR}[aria-busy="true"]`) !== null;
}
