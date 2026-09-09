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
// validator's alone.
//
// AND A TEXT THIS CONTROL CANNOT READ AS A FINITE NUMBER TRAVELS WITH THE MEMBER RATHER
// THAN WITH THE COMPONENT. `1e309` is a syntactically valid figure the platform hands over
// as typed, and `Number` turns it into `Infinity` — which is not JSON, which
// `numericTextOf` cannot display, and which serialization turns into `null`. Written into
// the answer, a person read a BLANK box while the answer carried a value they had never
// seen and could not clear. So the control reports an UNANSWERED node carrying that text,
// and the draft holds it on the member the text was typed into — which is what keeps it
// with its own list entry when an earlier entry is removed and the rows shift under React.
// Held in component state instead, the invalid text moved to whichever row inherited the
// reused subtree, or vanished with the one that unmounted.
//
// WHAT THE ANSWER HOLDS FOR IT IS THE PROJECTION'S ONE RULE and never this control's
// reading: a numeric control has no empty display worth a value, so the member is absent
// at either requiredness. `aria-invalid` says the same thing to a reader who cannot see
// the box. What is displayed is what is submitted, which is this subtree's whole rule, and
// here it is met by submitting nothing.

import { answeredScalar, unansweredScalar } from "../answer/schema-draft.js";
import { type SchemaFieldControlProps } from "../containers/schema-field-control.js";

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

/** A number, or nothing at all. */
export function SchemaNumberField(props: SchemaFieldControlProps): React.JSX.Element {
  // What the person typed that no member could carry, read off the draft rather than off
  // this component: the node is what the box shows, so a seed, a reset, or a row that
  // moved is displayed as whatever that member actually holds.
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

/** The typed text read as a member value, or nothing where no finite number is in it. */
function finiteNumberIn(typed: string): number | undefined {
  if (typed === "") {
    return undefined;
  }
  const read = Number(typed);
  return Number.isFinite(read) ? read : undefined;
}
