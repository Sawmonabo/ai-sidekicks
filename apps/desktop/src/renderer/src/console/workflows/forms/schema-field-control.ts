// What every one of the six controls is handed, declared once.
//
// A LEAF BECAUSE SIX MODULES READ IT and the chrome that renders them reads it too.
// Declared inside any one of the six it would make the other five import from a sibling
// control, which is how one field's module becomes the home of the shape all of them
// share — and the day a member moved, five files would follow it by hand.
//
// THE CONTROL OWNS THE VALUE AND NOTHING ELSE. The label, the description, the required
// mark and the schema's verdict are the field chrome's, one module up: a control that
// drew its own label would draw it six different ways, and a control that read the
// report would be six readers of one verdict.
//
// `value` IS `unknown` ON PURPOSE. The answer is a JSON value composed from a schema the
// wire delivered, so nothing has proved what sits at a member yet — a number control
// handed a string by a restored draft has to render that honestly rather than crash. Each
// control narrows what it can use and falls back to its own empty state for the rest.

import type { SchemaFieldDescriptor } from "./schema-fields.js";
import type { SchemaValidationReport } from "../../bridge/index.js";

/** One control's whole world: what it is, what it holds, and how it reports a change. */
export interface SchemaFieldControlProps {
  readonly field: SchemaFieldDescriptor;
  /** Whatever the answer currently holds at this member. Not yet proved to be anything. */
  readonly value: unknown;
  /** Report the new value. The hook owns where it lands in the answer. */
  readonly onChange: (value: unknown) => void;
  /** The id the chrome's label points at, so a click on the label reaches the control. */
  readonly controlId: string;
  /** The description element's id, where this field carries one. */
  readonly describedById: string | undefined;
}

/** The value read as text, which is what five of the six controls bind to. */
export function textValueOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * What the schema said about one member, addressed the way the mapper addresses it.
 *
 * A FUNCTION RATHER THAN A MAP BUILT ONCE, because the report is already a small list
 * and the alternative is a second index of it held beside the answer it describes — one
 * more thing to rebuild on every keystroke and one more thing to get out of step. A form
 * with a hundred controls and three issues walks three entries per control.
 *
 * The dotted join happens here and in `bridge/wire-shapes/json-schema-check.ts` and nowhere else, so the
 * two spellings of a member path cannot come apart.
 */
export function issuesForMember(
  report: SchemaValidationReport | undefined,
  memberPath: readonly string[],
): readonly string[] {
  const dotted = memberPath.join(".");
  return (report?.issues ?? [])
    .filter((issue) => issue.memberPath === dotted)
    .map((issue) => issue.message);
}
