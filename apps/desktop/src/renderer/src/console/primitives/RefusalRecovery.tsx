// The next move under a refusal, in the region the `action` slot receives.
//
// ONE SHELL FOR EVERY TABLE. `refusal-contract.ts` makes `action` a slot the caller
// fills — "the next move is the caller's to supply … the renderer never computes
// eligibility, so it never computes a remedy either" — and the three refusal shapes
// render whatever node arrives there. What arrives has always had the same shape: a
// sentence, then the exclusive alternatives where one code stands for more than one
// situation. Two families had written that shell each, under two class names whose
// declarations were identical property for property, which is a rendering one of them
// could change without the other noticing.
//
// IT LIVES IN `primitives/` BECAUSE ITS INPUTS DO. The props name no repo, no mount and
// no artifact: they are `RefusalRecoveryCopy`, declared beside the slot this fills. A
// home inside a view family would also have been unreachable to the next family that
// needs it — `console-view-family-isolation` forbids the edge — so the shell would have
// been copied a third time rather than imported.
//
// IT RENDERS NOTHING FOR A CODE WITH NO MOVE, and that is deliberate rather than
// defensive: a refusal a family has no recovery for shows the daemon's own code and
// sentence and stops there, which is more honest than a line of filler under every one.
// A caller with neither a recovery nor children does not render this at all.
//
// CHILDREN ARE INSIDE THE REGION AND NOT BESIDE IT. One code's remedy names data the
// refusal itself carried — the manifests a blocked delete listed — and a shell that made
// the caller render that as a sibling would let the two be composed apart: a sentence
// reading "delete the derivatives named below" with nothing below it is the rendering
// this composition exists to prevent.

import type { RefusalRecoveryCopy } from "./refusal-contract.js";

export interface RefusalRecoveryProps {
  /** What this family knows to do about the code, or nothing where it knows none. */
  readonly recovery?: RefusalRecoveryCopy | undefined;
  /** What the refusal itself carried, rendered inside the same region as the move. */
  readonly children?: React.ReactNode;
}

export function RefusalRecovery(props: RefusalRecoveryProps): React.JSX.Element {
  const { recovery, children } = props;
  return (
    <div className="meridian-refusal-recovery">
      {recovery === undefined ? null : (
        <p className="meridian-refusal-recovery__move">{recovery.nextMove}</p>
      )}
      {recovery === undefined || recovery.distinctions.length === 0 ? null : (
        // A LIST BECAUSE THE CASES ARE EXCLUSIVE. A code that carries these covers
        // several situations a person chooses between; run together as prose they would
        // read as steps to perform in order.
        <ul className="meridian-refusal-recovery__cases">
          {recovery.distinctions.map((distinction) => (
            <li key={distinction}>{distinction}</li>
          ))}
        </ul>
      )}
      {children}
    </div>
  );
}
