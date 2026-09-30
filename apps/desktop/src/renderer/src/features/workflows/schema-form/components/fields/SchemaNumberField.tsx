// A numeric answer; a blank box is absent, never `0` or `""`. Text that is not a finite
// number (`1e309` reads as `Infinity`, which serializes to `null`) is reported as an
// unanswered node carrying that text, so it stays with its own member when rows shift.

import { answeredScalar, unansweredScalar } from "../../answer/schema-draft.js";
import { type SchemaFieldControlProps } from "../field-control-props.js";

/** What a whole-number control steps by, matching the schema's `integer`. */
const INTEGER_STEP = "1";

/**
 * The step for a member whose schema declared none. The platform default of 1 gives `1.5` a
 * step mismatch, which blocks the native form's submit event with no message, so `any`
 * withdraws it. `integer` keeps a step of 1 and `multipleOf` steps by itself.
 */
const UNRESTRICTED_STEP = "any";

/** A number input; blank is absent, and unreadable text is held on the draft node. */
export function SchemaNumberField(props: SchemaFieldControlProps): React.JSX.Element {
  // Read off the draft, not component state, so a moved row shows what its member holds.
  const isShowingUnreadableText = props.unreadableText !== "";
  return (
    <input
      id={props.controlId}
      className="meridian-schema-field__input meridian-schema-field__input--figure"
      type="number"
      step={stepOf(props.field)}
      value={isShowingUnreadableText ? props.unreadableText : numericTextOf(props.value)}
      aria-describedby={props.describedById}
      aria-invalid={isShowingUnreadableText ? true : undefined}
      onChange={(event) => {
        const typed = event.currentTarget.value;
        const read = finiteNumberIn(typed);
        props.onChange(read === undefined ? unansweredScalar(typed) : answeredScalar(read));
      }}
    />
  );
}

/** The schema's own step where it declared one, else one for an integer, `any` otherwise. */
function stepOf(field: SchemaFieldControlProps["field"]): string {
  if (field.multipleOf !== undefined) {
    return String(field.multipleOf);
  }
  return field.isInteger ? INTEGER_STEP : UNRESTRICTED_STEP;
}

/** The text a numeric control shows for whatever the answer holds. */
function numericTextOf(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/** The typed text read as a member value, or nothing where no finite number is in it. */
function finiteNumberIn(typed: string): number | undefined {
  if (typed === "") {
    return undefined;
  }
  const read = Number(typed);
  return Number.isFinite(read) ? read : undefined;
}
