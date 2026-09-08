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

/**
 * What the schema said about ONE ENTRY of a list, addressed by the position it sits at.
 *
 * The validator addresses an array member by the array's path followed by the index —
 * `reviewers.0` — so an entry's own findings are invisible to a lookup asking for
 * `reviewers` alone, and a form that made only that lookup drew a control the schema had
 * a complaint about and rendered the complaint nowhere.
 *
 * Composed here rather than at the surface, and by appending a segment to the same reader
 * above, so the dotted spelling of a member path still has exactly one home.
 */
export function issuesForListEntry(
  report: SchemaValidationReport | undefined,
  memberPath: readonly string[],
  index: number,
): readonly string[] {
  return issuesForMember(report, [...memberPath, String(index)]);
}

/**
 * The one `aria-describedby` a control carries, composed from the ids it might have.
 *
 * The platform takes a space-separated id list in this attribute and drops an id that
 * points at no element, which is why a caller passes the ids it MIGHT have rather than
 * the ones it does: a control with neither a description nor a finding carries no
 * attribute at all rather than one naming an element that was never rendered.
 *
 * A function because two modules compose it — a scalar field's chrome and one list
 * entry's — and a second copy would drift the first time either grew a third describing
 * element, in the direction where the drift is silent.
 */
export function describedByOf(ids: readonly (string | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => id !== undefined);
  return present.length === 0 ? undefined : present.join(" ");
}
