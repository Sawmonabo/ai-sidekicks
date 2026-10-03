// One of a fixed set of answers, the one control with a third (unanswered) state. Two kinds
// reach it: an enumerated string and a boolean the answer may leave out (`choiceOptionsFor`).
// Enum options are set in mono as wire values. Options are keyed by index and the picked one is
// looked up in the list, so the empty unanswered value collides with no member (JSON Schema
// permits an enumeration to contain ""). A held value that is no option reads as unanswered.

import {
  choiceOptionsFor,
  type SchemaChoiceOption,
  type SchemaFieldControlProps,
} from "../field-control-props.js";
import { answeredScalar, UNANSWERED_SCALAR } from "../../answer/schema-draft.js";

/** What the unanswered option is worth; no option position spells the empty string. */
const UNANSWERED_OPTION_VALUE = "";

/** A select over the member's options, with an always-drawn unanswered option. */
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
        // Keyed by position: two options can show equal text.
        <option key={index} value={String(index)}>
          {option.optionLabel}
        </option>
      ))}
    </select>
  );
}

/** Where a held value sits among the options, or nothing where it is not one of them. */
function selectedIndexOf(
  options: readonly SchemaChoiceOption[],
  value: unknown,
): number | undefined {
  const found = options.findIndex((option) => option.memberValue === value);
  return found < 0 ? undefined : found;
}
