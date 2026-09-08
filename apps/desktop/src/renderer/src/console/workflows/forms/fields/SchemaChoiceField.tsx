// One of an enumerated set.
//
// THE MEMBERS ARE WIRE VALUES AND WEAR THE SIGNATURE. An enum member is the string the
// engine stores and the phase is answered with, not prose about it, so the options are
// set in mono like every other wire figure on a console surface.
//
// THE UNANSWERED OPTION IS PART OF THE CONTROL. A select with no empty option pre-answers
// the question with whichever member the author happened to write first, which is a value
// nobody chose reaching a submission. So the empty option is always drawn.
//
// AND IT RESERVES NO MEMBER VALUE, WHICH IS WHY EVERY OPTION CARRIES ITS POSITION. The
// obvious spelling — the unanswered option worth the empty string, every member worth
// itself — reserves a string that JSON Schema permits an enumeration to contain, and a
// schema that does contain it is drawn by this control rather than sent to the raw editor.
// The two options were then indistinguishable: picking either wrote "no answer", and the
// member was unsubmittable through a form that offered it. Options are keyed by INDEX
// instead, so the DOM value space and the member space have nothing in common — no index
// is the empty string, and no member is read as one. The value a person picked is looked
// up in the enumeration rather than taken off the event.
//
// A HELD VALUE THAT IS NO MEMBER READS AS UNANSWERED. A restored draft can hold anything;
// the schema's verdict is what reports that, and a control claiming a member nobody picked
// would be a second, quieter answer to the same question.

import { type SchemaFieldControlProps } from "../schema-field-control.js";

/**
 * What the unanswered option is worth.
 *
 * Not a member value and not reachable as one: every member is offered under `String` of
 * its position, and no position spells the empty string.
 */
const UNANSWERED_OPTION_VALUE = "";

/** Where a held value sits in the enumeration, or nothing where it is not in it. */
function selectedIndexOf(choices: readonly string[], value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const found = choices.indexOf(value);
  return found < 0 ? undefined : found;
}

/** One member of the schema's enumeration, or none yet. */
export function SchemaChoiceField(props: SchemaFieldControlProps): React.JSX.Element {
  const choices = props.field.choices ?? [];
  const selectedIndex = selectedIndexOf(choices, props.value);
  return (
    <select
      id={props.controlId}
      className="meridian-schema-field__select"
      value={selectedIndex === undefined ? UNANSWERED_OPTION_VALUE : String(selectedIndex)}
      aria-describedby={props.describedById}
      onChange={(event) => {
        const chosenPosition = event.currentTarget.value;
        props.onChange(
          chosenPosition === UNANSWERED_OPTION_VALUE ? undefined : choices[Number(chosenPosition)],
        );
      }}
    >
      <option value={UNANSWERED_OPTION_VALUE}>Not answered</option>
      {choices.map((choice, index) => (
        // Keyed by position for the reason the values are: an enumeration is a fixed list
        // from a schema read once, and two members can be equal strings while a position
        // cannot be two positions.
        <option key={index} value={String(index)}>
          {choice}
        </option>
      ))}
    </select>
  );
}
