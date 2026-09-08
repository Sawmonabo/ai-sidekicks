// A numeric answer, and the one place an empty control is not an empty string.
//
// A NUMBER MEMBER THAT IS BLANK IS ABSENT, NOT ZERO. Writing `0` for a cleared control
// would answer a question nobody answered, and writing `""` would put a string where the
// schema declared a number and make the verdict read as a type error rather than as a
// missing required member. So a blank control writes `undefined` and the schema says
// whether that is allowed.
//
// THE STEP IS NOT AN AFFORDANCE HERE, AND OMITTING IT IS NOT NEUTRAL. A number input
// with no `step` steps by one, so `1.5` carries `stepMismatch`; this control renders
// inside a native `<form>` that sets no `noValidate`, so that mismatch blocks the submit
// EVENT itself and the console's handler never runs. A fractional answer to a `number`
// member would therefore have been unsendable, with no verdict and no refusal anywhere
// to say why. `any` is the platform's own word for "the schema expressed no step", and
// it is what a `number` member gets.
//
// `integer` KEEPS ITS STEP OF ONE, and that is the same rule arriving earlier rather
// than a second authority: the platform's whole-number constraint and the schema's
// `integer` say one thing, so a control that refuses `1.5` refuses exactly what the
// compiled validator refuses. A declared `multipleOf` is the same shape of rule and
// takes the same seat: the schema expressed a step, the validator enforces it, and the
// control stepping by it refuses nothing the verdict would not. Everything the control
// and the validator do NOT share — requiredness, ranges, enum membership — stays the
// validator's alone, which is why this file reads two members of the descriptor and
// nothing else.

import { type SchemaFieldControlProps } from "../schema-field-control.js";

/** What a whole-number control steps by, matching the schema's `integer`. */
const INTEGER_STEP = "1";

/**
 * The step for a member whose schema declared none.
 *
 * The platform's default is `1`, not "unrestricted", so this has to be written out: it
 * is what withdraws the browser's own opinion about precision from a member the schema
 * never expressed one for.
 */
const UNRESTRICTED_STEP = "any";

/**
 * What the control steps by: the schema's own step where it declared one, else the
 * type's — one for a whole number, unrestricted for a number the schema left open.
 */
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

/** A number, or nothing at all. */
export function SchemaNumberField(props: SchemaFieldControlProps): React.JSX.Element {
  return (
    <input
      id={props.controlId}
      className="meridian-schema-field__input meridian-schema-field__input--figure"
      type="number"
      step={stepOf(props.field)}
      value={numericTextOf(props.value)}
      aria-describedby={props.describedById}
      onChange={(event) => {
        const typed = event.currentTarget.value;
        props.onChange(typed === "" ? undefined : Number(typed));
      }}
    />
  );
}
