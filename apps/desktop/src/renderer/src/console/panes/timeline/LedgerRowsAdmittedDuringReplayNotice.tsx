// Rows the log admitted after a walk began — an absence the walk cannot close.
//
// Its own module for the one-component rule, and the separation it keeps is the
// point: a row ahead of the position comes back when the dock is scrubbed forward,
// and a row admitted after the walk began was never in the walk at all, so scrubbing
// to the very end of it reveals nothing. Reporting the two together would offer an
// action that cannot work for half the rows it named.

import { Nothing } from "../../primitives/index.js";

/** What the replay's own walk can never reach, and the one act that can. */
export function LedgerRowsAdmittedDuringReplayNotice(props: {
  readonly count: number;
  readonly onEndReplay: () => void;
}): React.JSX.Element | null {
  if (props.count === 0) {
    return null;
  }
  return (
    <Nothing
      // `empty` AND NOT `not-loaded`, which is what the sentences around it name:
      // that kind is a skeleton, so its title is announced rather than set and its
      // detail is dropped, which is right for a read in flight and wrong for a
      // settled fact nothing will replace. This walk succeeded and holds none of
      // these rows, and the next move is a control — which is the slot `empty`
      // carries and the reason the button is passed rather than drawn beside it.
      kind="empty"
      placement="surface"
      title="The session moved on while this replay was running."
      detail={`${String(props.count)} entr${props.count === 1 ? "y" : "ies"} arrived after this replay started. A replay walks the rows it began with, so scrubbing forward does not reach them.`}
      action={
        <button type="button" className="meridian-ledger__jump-action" onClick={props.onEndReplay}>
          Leave the replay and catch up
        </button>
      }
    />
  );
}
