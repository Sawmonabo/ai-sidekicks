// One of an enumerated set.
//
// THE MEMBERS ARE WIRE VALUES AND WEAR THE SIGNATURE. An enum member is the string the
// engine stores and the phase is answered with, not prose about it, so the options are
// set in mono like every other wire figure on a console surface.
//
// THE UNANSWERED OPTION IS PART OF THE CONTROL. A select with no empty option pre-answers
// the question with whichever member the author happened to write first, which is a value
// nobody chose reaching a submission. So the empty option is always drawn, and clearing
// back to it writes `undefined` rather than the empty string, which is not an enum member.

import { textValueOf, type SchemaFieldControlProps } from "../schema-field-control.js";

/** What the empty option is worth as a form value. Never a member of any enum. */
const UNANSWERED_OPTION_VALUE = "";

/** One member of the schema's enumeration, or none yet. */
export function SchemaChoiceField(props: SchemaFieldControlProps): React.JSX.Element {
  return (
    <select
      id={props.controlId}
      className="meridian-schema-field__select"
      value={textValueOf(props.value)}
      aria-describedby={props.describedById}
      onChange={(event) => {
        const chosen = event.currentTarget.value;
        props.onChange(chosen === UNANSWERED_OPTION_VALUE ? undefined : chosen);
      }}
    >
      <option value={UNANSWERED_OPTION_VALUE}>Not answered</option>
      {(props.field.choices ?? []).map((choice) => (
        <option key={choice} value={choice}>
          {choice}
        </option>
      ))}
    </select>
  );
}
