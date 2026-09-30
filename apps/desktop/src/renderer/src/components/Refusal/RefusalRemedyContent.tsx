// The next move under a refusal, in the region the `action` prop fills; one component for every
// table's `RefusalRemedy`. It renders nothing for a code with no move, so the daemon's own code and
// sentence stand alone. Children sit inside the region, not beside it, so a sentence that points
// at data the refusal carried cannot be composed apart from it.

import "./Refusal.css";

import type { RefusalRemedy } from "@renderer/lib/refusal-remedies.js";

/** Props for `RefusalRemedyContent`. */
export interface RefusalRemedyContentProps {
  /** What is known to do about the code, or nothing where nothing is. */
  readonly remedy?: RefusalRemedy | undefined;
  /** What the refusal itself carried, rendered inside the same region as the move. */
  readonly children?: React.ReactNode;
}

/** The remedy under a refusal: its next move and any exclusive cases. */
export function RefusalRemedyContent(props: RefusalRemedyContentProps): React.JSX.Element {
  const { remedy, children } = props;
  const distinctions = remedy !== undefined && "distinctions" in remedy ? remedy.distinctions : [];
  return (
    <div className="meridian-refusal-remedy">
      {remedy === undefined ? null : (
        <p className="meridian-refusal-remedy__move">{remedy.nextMove}</p>
      )}
      {distinctions.length === 0 ? null : (
        // A list because the cases are exclusive alternatives, not steps in order.
        <ul className="meridian-refusal-remedy__cases">
          {distinctions.map((distinction) => (
            <li key={distinction}>{distinction}</li>
          ))}
        </ul>
      )}
      {children}
    </div>
  );
}
