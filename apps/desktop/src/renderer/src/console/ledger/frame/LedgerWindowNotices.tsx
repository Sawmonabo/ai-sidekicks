// The two ways the own-built window degrades, said out loud.
//
// Its own module for the one-component rule. Both notices are residuals of what
// `Spec-023 §Console Libraries`' timeline-virtualization row requires of an own-built
// window — "stable keys", and a ceiling under the 33,554,431 px Chromium caps an
// element's height at — and both are the kind of defect that is invisible until
// somebody scrolls to exactly the wrong place. Rendering them costs two lines and
// turns a mystery into a report.

import { Nothing } from "../../primitives/index.js";
import { type LedgerViewportBinding } from "./viewport-binding.js";

export interface LedgerWindowNoticesProps {
  readonly binding: LedgerViewportBinding;
}

/** What the window could not hold to, named where it happened. */
export function LedgerWindowNotices(props: LedgerWindowNoticesProps): React.JSX.Element | null {
  const { duplicateKeyCount } = props.binding.snapshot.keyProjection;
  const isPastElementCeiling = props.binding.isPastElementCeiling;
  if (duplicateKeyCount === 0 && !isPastElementCeiling) {
    return null;
  }
  return (
    <div className="meridian-ledger-viewport__notices">
      {duplicateKeyCount === 0 ? null : (
        <Nothing
          kind="error"
          placement="inline"
          title="Some entries share an identifier."
          detail="Each is drawn and measured on its own until the projection sends distinct keys."
        />
      )}
      {isPastElementCeiling ? (
        <Nothing
          kind="error"
          placement="inline"
          title="The log is taller than this window can draw."
          detail="Older entries below the drawable ceiling are reachable through find and the rail."
        />
      ) : null}
    </div>
  );
}
