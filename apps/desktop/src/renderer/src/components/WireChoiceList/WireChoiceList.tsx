// Wire identifiers offered as a list of choices.
//
// ONE list, and every view that offers wire identifiers to choose between. The
// sessions destination offers the node's sessions to open in place; the auxiliary
// context picker asks which session a window should follow, and then — on a route
// whose grammar takes one — which agent inside it; the workflows destination asks
// which session its definitions should resolve from. All of them render the identical
// row, a wire identifier and a way to pick it, so the row lives here rather than once
// per caller and a change to how a choice reads on screen is one edit rather than
// several that drift. The list is deliberately not counted in this sentence: a count
// here is a claim that goes stale the first time a caller is added without it.
//
// The component is named for what it renders and not for what any one caller is
// choosing: it took the sessions name while sessions were its only subject, and an
// agent list passed to a `sessionIds` prop would have been a lie in the one place
// the compiler cannot catch one.
//
// WHY IT LIVES IN `components/`. Its only input is a list of wire strings and its
// only dependency is the mono figure beside it, so it belongs in the shared
// components, which sit below the features. One feature never imports another, so a
// row kept inside one feature could not be reached by the rest; kept here, every
// caller renders the same row.
//
// What is deliberately NOT shared is the absence beside it. A picker with nothing to
// offer and a sessions list with nothing to show are different next moves, and absences
// with different next moves render differently, so each caller writes its own — this
// component renders rows and nothing else, and a caller with no rows does not call it.
//
// The identifier renders through `WireFigure`, which is the console's one mono
// figure: mono is the signature that a value came from the wire, and a
// session or agent id is exactly that. There is no title beside it: the directory
// read carries an optional one and neither producer in the tree supplies it, so a
// row rendered by title today would be rendered by a label the console made up —
// prose paraphrasing a wire figure, which the console never does. A subject with no
// name renders by its identifier, which is what this row does.

import "./WireChoiceList.css";

import { WireFigure } from "../WireFigure/WireFigure.js";

export interface WireChoiceListProps {
  /** The identifiers to offer, in the order they should read. */
  readonly values: readonly string[];
  readonly onSelect: (value: string) => void;
  /** Names the list for assistive technology. Each caller asks its own question. */
  readonly label: string;
}

/** @consumedBy the composer's question card, which lists an ask's choices */
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
