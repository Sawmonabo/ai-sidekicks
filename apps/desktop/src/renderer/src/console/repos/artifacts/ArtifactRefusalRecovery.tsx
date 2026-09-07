// The next move under an artifact refusal, rendered into the slot the refusal shapes
// reserve — plus, on the one code that carries one, the list the daemon itself sent.
//
// THE SHELL IS THE PRIMITIVE'S AND THE DATA HALF IS THIS FAMILY'S.
// `primitives/RefusalRecovery.tsx` renders the region every family's recovery lands in
// — the move, then the exclusive cases — because those inputs name nothing about an
// artifact, and this family had written that shell a second time under a class name
// whose declarations matched the mounts family's property for property. What is left
// here is the half only this family has.
//
// TWO HALVES, ONE ANSWER, WHICH IS WHY THE LIST IS THE SHELL'S CHILDREN AND NOT ITS
// SIBLING. The copy half is what a person does next (`artifact-refusal-copy.ts`); the
// data half is which manifests a blocked delete named, which arrives on the refusal as
// a registered extension (`core/refusal-extensions.ts`). Composed by the caller they
// could be composed apart — a remedy saying "delete the derivatives named below" with
// nothing below it is the one rendering this must not produce.
//
// IT RENDERS NOTHING WHERE THERE IS NOTHING TO SAY, and that is deliberate rather than
// defensive: a refusal this family has no recovery for and no list on shows the
// daemon's own code and sentence and stops there, which is more honest than a line of
// filler under every one. {@link artifactRefusalAction} is what call sites ask, so the
// `action` slot stays absent rather than holding an empty element.
//
// THE IDS ARE THE WIRE'S AND THE COUNT IS A READING OF THEM. Every id renders through
// `WireFigure`, verbatim in mono, in the order the refusal sent them — the daemon
// bounds the list to the first fifty ascending and the console neither sorts nor
// truncates. The capped sentence is stated only where the total the refusal carried
// EXCEEDS the ids it sent, because that is the only reading under which the list is
// partial; where the two agree, the list is the whole set and saying "50 of 50" would
// invent a cap nobody hit.

import { RefusalRecovery, WireFigure, formatCount } from "../../primitives/index.js";
import type { WireReferencingArtifacts } from "../../core/index.js";
import {
  artifactRefusalRecovery,
  daemonSpokenRefusal,
  type ArtifactRefusalRecovery as ArtifactRefusalRecoveryCopy,
  type ArtifactSurfaceRefusal,
} from "./artifact-refusal-copy.js";

export interface ArtifactRefusalRecoveryProps {
  /** What this family knows to do about the code, or nothing where it knows none. */
  readonly recovery?: ArtifactRefusalRecoveryCopy | undefined;
  /** The manifests the refusal itself named, on the one code that names any. */
  readonly referencingArtifacts?: WireReferencingArtifacts | undefined;
}

export function ArtifactRefusalRecovery(props: ArtifactRefusalRecoveryProps): React.JSX.Element {
  const { recovery, referencingArtifacts } = props;
  return (
    <RefusalRecovery recovery={recovery}>
      {referencingArtifacts === undefined ? null : renderReferencingArtifacts(referencingArtifacts)}
    </RefusalRecovery>
  );
}

/**
 * The recovery for one refusal, or nothing at all.
 *
 * The call sites' one question, answered here rather than at each of them: a row, a
 * payload section and a panel card all fill the same `action` slot, and three copies of
 * "is there anything to put in it" is three chances for one of them to render an empty
 * element. `undefined` is what the slot takes when the answer is no.
 *
 * It reads the DAEMON's refusal and not necessarily the one that arrived — every call
 * this family makes goes through the growth port, which wraps a rejected call in its own
 * seam refusal and carries the daemon's on `cause`.
 */
export function artifactRefusalAction(
  refusal: ArtifactSurfaceRefusal,
): React.JSX.Element | undefined {
  const spoken = daemonSpokenRefusal(refusal);
  const recovery = artifactRefusalRecovery(spoken.code);
  const { referencingArtifacts } = spoken;
  if (recovery === undefined && referencingArtifacts === undefined) {
    return undefined;
  }
  return (
    <ArtifactRefusalRecovery recovery={recovery} referencingArtifacts={referencingArtifacts} />
  );
}

/**
 * The manifests the refusal named, and whether that list is the whole set.
 *
 * A render helper rather than a second component, on `ArtifactsPanel.tsx`'s rule: it
 * holds no state and takes no hooks, so mounting it as an element type would buy a
 * reconciliation boundary nothing needs.
 */
function renderReferencingArtifacts(
  referencingArtifacts: WireReferencingArtifacts,
): React.JSX.Element {
  const { ids, total } = referencingArtifacts;
  const isCapped = total !== undefined && total > ids.length;
  return (
    <div className="meridian-artifact-referencing">
      <p className="meridian-artifact-referencing__head">
        {isCapped
          ? `The first ${formatCount(ids.length)} of ${formatCount(total)}, in the order the daemon sent them. The rest are reachable by reading this artifact's derivatives.`
          : `Named by the daemon: ${formatCount(ids.length)}.`}
      </p>
      <ul className="meridian-artifact-referencing__list">
        {ids.map((referencingArtifactId) => (
          <li key={referencingArtifactId}>
            <WireFigure value={referencingArtifactId} />
          </li>
        ))}
      </ul>
    </div>
  );
}
