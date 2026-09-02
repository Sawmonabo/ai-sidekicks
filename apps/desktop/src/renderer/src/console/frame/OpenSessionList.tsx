// The sessions this window has open, as a list of choices.
//
// ONE list, two surfaces. The context picker asks which session an auxiliary
// window should follow; the sessions surface offers the same set to open in place.
// Both render the identical row — a session id and a way to pick it — so the row
// lives here rather than twice, and a change to how a session reads on screen is
// one edit instead of two that drift.
//
// What is deliberately NOT shared is the absence beside it. A picker with nothing
// to offer and a sessions list with nothing to show are different next moves, which
// `Spec-023 §Console Design (Meridian)` rule 8 makes a distinction rather than a
// detail, so each caller writes its own — this component renders rows and nothing
// else, and a caller with no rows does not call it.
//
// The id renders through `WireFigure`, which is the console's one mono figure: rule
// 4 makes mono the signature that a value came from the wire, and a session id is
// exactly that. There is no title beside it because no read supplies one — the
// console has no session-directory wire — and a console-invented label would be
// prose paraphrasing a wire figure, which the same rule forbids.

import { WireFigure } from "../primitives/index.js";

export interface OpenSessionListProps {
  readonly sessionIds: readonly string[];
  readonly onSelect: (sessionId: string) => void;
  /** Names the list for assistive technology. Each surface asks its own question. */
  readonly label: string;
}

export function OpenSessionList(props: OpenSessionListProps): React.JSX.Element {
  return (
    <ul className="meridian-open-sessions" aria-label={props.label}>
      {props.sessionIds.map((sessionId) => (
        <li key={sessionId}>
          <button
            type="button"
            className="meridian-open-sessions__choice"
            onClick={() => {
              props.onSelect(sessionId);
            }}
          >
            <WireFigure value={sessionId} />
          </button>
        </li>
      ))}
    </ul>
  );
}
