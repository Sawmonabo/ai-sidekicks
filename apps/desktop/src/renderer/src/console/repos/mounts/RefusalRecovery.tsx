// The next move under a refusal, rendered into the slot the refusal shapes reserve.
//
// A COMPONENT AND NOT A SHAPE OF ITS OWN. `primitives/refusal-contract.ts` makes
// `action` a slot the caller fills — "the next move is the caller's to supply … the
// renderer never computes eligibility, so it never computes a remedy either" — and the
// three refusal shapes render whatever node arrives there. So this family's recovery
// reaches the screen by filling that slot rather than by a fourth refusal shape, and
// which SHAPE a refusal takes stays the call site's decision about blast radius.
//
// IT RENDERS NOTHING FOR A CODE WITH NO MOVE, and that is deliberate rather than
// defensive: a refusal this family has no recovery for shows the daemon's own code and
// sentence and stops there, which is more honest than a line of filler under every one.
// The caller passes the recovery it looked up; a caller with none passes `undefined`
// and this component is not rendered at all.

import type { MountRefusalRecovery } from "./mount-refusal-copy.js";

export interface RefusalRecoveryProps {
  readonly recovery: MountRefusalRecovery;
}

export function RefusalRecovery(props: RefusalRecoveryProps): React.JSX.Element {
  const { recovery } = props;
  return (
    <div className="meridian-mount-recovery">
      <p className="meridian-mount-recovery__move">{recovery.nextMove}</p>
      {recovery.distinctions.length === 0 ? null : (
        // A LIST BECAUSE THE CASES ARE EXCLUSIVE. The one code that carries these
        // covers three situations a person chooses between; run together as prose they
        // would read as three steps to perform in order.
        <ul className="meridian-mount-recovery__cases">
          {recovery.distinctions.map((distinction) => (
            <li key={distinction}>{distinction}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
