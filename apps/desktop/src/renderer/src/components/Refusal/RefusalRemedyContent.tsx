// The next move under a refusal, in the region the `action` prop fills; one component for every
// table's `RefusalRemedy`. A code with no move has no remedy and so draws none of this.

import "./Refusal.css";

import type { RefusalRemedy } from "#renderer/lib/refusal/remedies.js";

/** Props for `RefusalRemedyContent`. */
export interface RefusalRemedyContentProps {
  /** What is known to do about the code. */
  readonly remedy: RefusalRemedy;
}

/** The remedy under a refusal: its next move. */
export function RefusalRemedyContent(props: RefusalRemedyContentProps): React.JSX.Element {
  const { remedy } = props;
  return (
    <div className="meridian-refusal-remedy">
      <p className="meridian-refusal-remedy__move">{remedy.nextMove}</p>
    </div>
  );
}
