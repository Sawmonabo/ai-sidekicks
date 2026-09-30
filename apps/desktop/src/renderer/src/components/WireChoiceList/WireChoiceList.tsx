// Wire identifiers offered as a list of choices: one row (a wire identifier and a way to pick it)
// for every view that offers them, so a change to how a choice reads is one edit. It is in
// `components/` because one feature never imports another. It renders rows only; each caller
// writes its own empty state, since absences with different next moves render differently.
//
// The identifier renders through `WireFigure`, in mono. There is no title beside it: prose
// paraphrasing a wire figure is never done, and a subject with no name renders by its identifier.

import "./WireChoiceList.css";

import { WireFigure } from "../WireFigure/WireFigure.js";

/** Props for `WireChoiceList`. */
export interface WireChoiceListProps {
  /** The identifiers to offer, in the order they should read. */
  readonly values: readonly string[];
  readonly onSelect: (value: string) => void;
  /** Names the list for assistive technology. Each caller asks its own question. */
  readonly label: string;
}

/**
 * A list of buttons, one per wire identifier, calling `onSelect` with the chosen value.
 *
 * @consumedBy the composer's question card, which lists an ask's choices
 */
export function WireChoiceList(props: WireChoiceListProps): React.JSX.Element {
  return (
    <ul className="meridian-choice-list" aria-label={props.label}>
      {props.values.map((value) => (
        <li key={value}>
          <button
            type="button"
            className="meridian-choice-list__choice"
            onClick={() => {
              props.onSelect(value);
            }}
          >
            <WireFigure value={value} />
          </button>
        </li>
      ))}
    </ul>
  );
}
