// A numeric answer, and the one place an empty control is not an empty string.
//
// A NUMBER MEMBER THAT IS BLANK IS ABSENT, NOT ZERO. Writing `0` for a cleared control
// would answer a question nobody answered, and writing `""` would put a string where the
// schema declared a number and make the verdict read as a type error rather than as a
// missing required member. So a blank control writes `undefined` and the schema says
// whether that is allowed.
//
// `integer` STEPS BY ONE AND IS STILL THE SCHEMA'S CALL. The step is an affordance; the
// compiled validator is what refuses a fractional answer to an integer member, because a
// control that enforced it would be a second authority on the same rule.

import { type SchemaFieldControlProps } from "../schema-field-control.js";

/** What a whole-number control steps by, against the browser's own default of one. */
const INTEGER_STEP = 1;

/** The text a numeric control shows for whatever the answer holds. */
function numericTextOf(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/** A number, or nothing at all. */
export function SchemaNumberField(props: SchemaFieldControlProps): React.JSX.Element {
  return (
    <input
      id={props.controlId}
      className="meridian-schema-field__input meridian-schema-field__input--figure"
      type="number"
      step={props.field.isInteger ? INTEGER_STEP : undefined}
      value={numericTextOf(props.value)}
      aria-describedby={props.describedById}
      onChange={(event) => {
        const typed = event.currentTarget.value;
        props.onChange(typed === "" ? undefined : Number(typed));
      }}
    />
  );
}
