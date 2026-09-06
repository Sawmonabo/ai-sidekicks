// The three facts every plan-owned body slot declares.
//
// Several places in the console are holes another plan fills — the timeline row,
// the context-window and rate-limit meters, the run controls, the cost receipt.
// Each is the same arrangement: this repository's console mounts a slot, a
// different plan authors the body, and a fixture shell stands in until it does.
// Each is also, left alone, the same three unwritten facts, discovered by whoever
// next reads the file and guesses.
//
// So the arrangement is a type. A slot declares WHO owns the body, WHAT the
// mounting side owes, and WHERE the shell dies — and a slot that cannot answer all
// three has not decided what it is.
//
// TYPES ONLY. There is deliberately no component here. A slot is rendered by the
// family that mounts it, in that family's own layout, with that family's own
// empty-state treatment; a shared `<OwnerSlot>` would put those three decisions in
// one file that six families then need to widen. What is shared is the DECLARATION,
// which is what drifts when it is prose.

// Consumed by T-023p-1C-2, T-023p-1C-3
/**
 * What a plan-owned slot says about itself.
 *
 * DEVELOPER-FACING, AND NEVER RENDERED. Every member is prose, and the prose
 * names governance work — which is exactly why no console surface may display
 * one. The repository's standing rule keeps governance ids out of what a
 * participant sees; a slot's empty state names the FEATURE that has not been
 * built, and this declaration is read by the people building it. Nothing branches
 * on any member: they exist so the three answers live in the file rather than in
 * a reviewer's memory.
 */
export interface OwnerSlotContract {
  /** The task that authors the body. */
  readonly owningTask: string;
  /** What the mounting family owes the body — the props, the placement, the reads. */
  readonly mountObligation: string;
  /** The PR or task in which the fixture shell is deleted, not merely superseded. */
  readonly deleteShellIn: string;
}

/**
 * What a mounting family renders a plan-owned slot with.
 *
 * `body` is `undefined` while nobody has filled the slot, and the mount renders
 * the "reserved, not stubbed" answer rather than a placeholder that looks like a
 * broken feature. It is a required member carrying `undefined` rather than an
 * optional one, so a mount that forgot to read the seat is a compile error at the
 * construction site instead of an absent key that renders identically.
 */
export interface OwnerSlotProps<TBody> {
  readonly contract: OwnerSlotContract;
  readonly body: TBody | undefined;
}
