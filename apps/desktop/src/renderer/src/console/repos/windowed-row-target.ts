// What a windowed row hands the one control it delegates its tab stop to.
//
// DERIVED FROM THE PRIMITIVE, NEVER RESTATED. `primitives/WindowedListRow.tsx`
// declares the shape and does not publish it through the `primitives/` door yet, and a
// family may not widen another family's barrel — so this reads the type back off the
// component the door DOES publish rather than writing the two members again. A second
// declaration would be two closed sets that agree until the marker attribute is
// renamed on one side, which is the exact drift `windowed-row-markers.ts` exists to
// prevent between the row and the keyboard.
//
// It is at the family root because both of this family's windowed lists delegate —
// the changed-file list and the restore-path enumeration — and the second use is where
// a helper is hoisted. When the door publishes `WindowedRowTargetProps`, this module
// is deleted and both consumers import it; nothing about their shape moves, because
// this IS that type.

import { type WindowedListRow } from "../primitives/index.js";

/** The children arm that is a renderer rather than content. */
type WindowedRowRenderer = Extract<
  React.ComponentProps<typeof WindowedListRow>["children"],
  (...args: never[]) => unknown
>;

/**
 * The roving `tabIndex` and the target marker, spread onto exactly one control.
 *
 * A row that delegates writes neither on itself, so the control this is spread onto is
 * the list's one tab stop and the element the roving keyboard focuses. Spreading it
 * onto two controls in one row would put two stops in a list that claims one.
 */
export type WindowedRowTargetProps = Parameters<WindowedRowRenderer>[0];
