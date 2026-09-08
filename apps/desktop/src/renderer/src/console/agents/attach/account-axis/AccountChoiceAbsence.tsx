// Why there is no account picker, in the words of whichever answer produced it.
//
// FOUR ABSENCES AND NOT ONE EMPTY LIST. A driver nobody has chosen, a registry read
// still in flight, a read the node refused, a driver this build cannot match to a
// provider, and a provider with no accounts registered are five different facts about
// why an account cannot be chosen right now, and exactly one of them is "there are
// none". A field that drew an empty picker over any of the other four would report a
// registry that had not answered as a registry that had answered nothing.
//
// THE REFUSAL RENDERS VERBATIM AND CARRIES ITS OWN WAY OUT. A refused registry read
// is terminal until something asks again, so without the re-read this field would say
// one line of error text for the life of the dialog.

import { InlineRefusal, Nothing } from "../../../primitives/index.js";
import type { AttachAccountAxisReading } from "./account-axis.js";

export interface AccountChoiceAbsenceProps {
  readonly reading: AttachAccountAxisReading;
  /** Ask the node's one account-plane reading for a fresh read. */
  readonly onReopen: () => void;
}

export function AccountChoiceAbsence(props: AccountChoiceAbsenceProps): React.JSX.Element {
  const { reading, onReopen } = props;
  if (reading.kind === "driver-unchosen") {
    return (
      <Nothing
        kind="not-checked"
        title="Choose a driver first."
        detail="An account belongs to one provider, so which accounts may be pinned follows from the driver."
      />
    );
  }
  if (reading.kind === "reading") {
    return <Nothing kind="not-loaded" title="Reading this node's provider accounts" />;
  }
  if (reading.kind === "refused") {
    return (
      <InlineRefusal
        code={reading.refusal.code}
        detail={reading.refusal.detail}
        action={
          <button type="button" onClick={onReopen}>
            Try again
          </button>
        }
      />
    );
  }
  if (reading.kind === "unknown-provider") {
    return (
      <Nothing
        kind="not-checked"
        title="This driver names no provider the account registry knows."
        detail="Nothing is offered rather than another provider's accounts, which would pin a run to an account nobody chose for it."
      />
    );
  }
  return (
    <Nothing
      kind="empty"
      title="No account is registered for this provider on this node."
      detail="Attaching without one is what asks the daemon for the provider's registered default."
    />
  );
}
