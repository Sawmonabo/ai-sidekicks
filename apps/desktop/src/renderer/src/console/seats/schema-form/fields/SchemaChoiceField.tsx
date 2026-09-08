// One of a fixed set of answers, and the one control on this form with a third state.
//
// TWO KINDS REACH IT. An enumerated string is the one it was written for; the other is a
// boolean the answer may leave out, which a two-state box cannot represent at all. What
// each one OFFERS is `choiceOptionsFor`'s, beside the props this control is handed, so the
// two halves of every lookup — which options exist and what a picked one is worth — are
// one reading rather than two that agree today.
//
// AN ENUM MEMBER IS A WIRE VALUE AND WEARS THE SIGNATURE. It is the string the engine
// stores and the phase is answered with, not prose about it, so the options are set in
// mono like every other wire figure on a console surface. The boolean pair is named rather
// than spelled `true` and `false` — a person answers a yes-or-no question with a word, and
// the value it carries is the option's own and never its text.
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
// up in the option list rather than taken off the event, which is also what lets a member
// value be something a DOM attribute could never carry.
//
// A HELD VALUE THAT IS NO OPTION READS AS UNANSWERED. A restored draft can hold anything;
// the schema's verdict is what reports that, and a control claiming an answer nobody
// picked would be a second, quieter answer to the same question.

import {
  choiceOptionsFor,
  type SchemaChoiceOption,
  type SchemaFieldControlProps,
} from "../schema-field-control.js";
import { answeredScalar, UNANSWERED_SCALAR } from "../schema-draft.js";

/**
 * What the unanswered option is worth.
 *
 * Not a member value and not reachable as one: every option is offered under `String` of
 * its position, and no position spells the empty string.
 */
const UNANSWERED_OPTION_VALUE = "";

/** Where a held value sits among the options, or nothing where it is not one of them. */
function selectedIndexOf(
  options: readonly SchemaChoiceOption[],
  value: unknown,
): number | undefined {
  const found = options.findIndex((option) => option.memberValue === value);
  return found < 0 ? undefined : found;
}

/** One of the answers this member has, or none yet. */
export function SchemaChoiceField(props: SchemaFieldControlProps): React.JSX.Element {
  const options = choiceOptionsFor(props.field);
  const selectedIndex = selectedIndexOf(options, props.value);
  return (
    <select
      id={props.controlId}
      className="meridian-schema-field__select"
      value={selectedIndex === undefined ? UNANSWERED_OPTION_VALUE : String(selectedIndex)}
      aria-describedby={props.describedById}
      onChange={(event) => {
        const chosenPosition = event.currentTarget.value;
        const picked = options[Number(chosenPosition)];
        props.onChange(
          chosenPosition === UNANSWERED_OPTION_VALUE || picked === undefined
            ? UNANSWERED_SCALAR
            : answeredScalar(picked.memberValue),
        );
      }}
    >
      <option value={UNANSWERED_OPTION_VALUE}>Not answered</option>
      {options.map((option, index) => (
        // Keyed by position for the reason the values are: the option list is fixed from a
        // schema read once, and two options can show equal text while a position cannot be
        // two positions.
        <option key={index} value={String(index)}>
          {option.optionLabel}
        </option>
      ))}
    </select>
  );
}
