// The next move under an artifact refusal, rendered into the slot the refusal shapes
// reserve — plus, on the one code that carries one, the list the daemon itself sent.
//
// A COMPONENT AND NOT A SHAPE OF ITS OWN. `primitives/refusal-contract.ts` makes
// `action` a slot the caller fills — "the next move is the caller's to supply … the
// renderer never computes eligibility, so it never computes a remedy either" — and the
// three refusal shapes render whatever node arrives there. So this family's recovery
// reaches the screen by filling that slot rather than by a fourth refusal shape, and
// which SHAPE a refusal takes stays the call site's decision about blast radius.
//
// TWO HALVES, ONE COMPONENT, BECAUSE THEY ARE ONE ANSWER. The copy half is what a
// person does next (`artifact-refusal-copy.ts`); the data half is which manifests a
// blocked delete named, which arrives on the refusal as a registered extension
// (`core/refusal-extensions.ts`). Split into two components the row would compose them
// itself and could compose them apart — a remedy saying "delete the derivatives named
// below" with nothing below it is the one rendering this must not produce.
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

import { WireFigure, formatCount } from "../../primitives/index.js";
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
    <div className="meridian-artifact-recovery">
      {recovery === undefined ? null : (
        <p className="meridian-artifact-recovery__move">{recovery.nextMove}</p>
      )}
      {recovery === undefined || recovery.distinctions.length === 0 ? null : (
        // A LIST BECAUSE THE CASES ARE EXCLUSIVE. The one code that carries these
        // covers three enforcement points a person chooses between; run together as
        // prose they would read as three steps to perform in order.
        <ul className="meridian-artifact-recovery__cases">
          {recovery.distinctions.map((distinction) => (
            <li key={distinction}>{distinction}</li>
          ))}
        </ul>
      )}
      {referencingArtifacts === undefined ? null : renderReferencingArtifacts(referencingArtifacts)}
    </div>
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
    <div className="meridian-artifact-recovery__referencing">
      <p className="meridian-artifact-recovery__referencing-head">
        {isCapped
          ? `The first ${formatCount(ids.length)} of ${formatCount(total)}, in the order the daemon sent them. The rest are reachable by reading this artifact's derivatives.`
          : `Named by the daemon: ${formatCount(ids.length)}.`}
      </p>
      <ul className="meridian-artifact-recovery__referencing-list">
        {ids.map((referencingArtifactId) => (
          <li key={referencingArtifactId}>
            <WireFigure value={referencingArtifactId} />
          </li>
        ))}
      </ul>
    </div>
  );
}
