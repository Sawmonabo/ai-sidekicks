// Where a body another plan authors is mounted, and what stands there until it is.
//
// `owner-slots.ts` says who owns each of the five bodies; this is what the mount
// looks like while `body` is `undefined`. The answer is the "reserved, not stubbed"
// rule: the surface says the feature has not been built, which is true, rather than
// drawing a shape that reads as a broken one.
//
// THE CONTRACT IS CARRIED AND NEVER RENDERED. `slot.contract` names governance work
// — a task id, a mount obligation, a deletion obligation — and the seat's own rule
// is that no console surface may display one. So this component reads exactly one
// member of the value it is handed, `body`, and the copy a person sees is the
// caller's, written for a person. The contract travels anyway, because a mount that
// took only the body would let a fifth slot appear with nobody named against it.

import { Nothing } from "../primitives/index.js";
import type { OwnerSlotProps } from "../seats/index.js";

export interface WorkflowSlotMountProps {
  readonly slot: OwnerSlotProps<React.ReactNode>;
  /** What is not here yet, in one sentence, written for a person. */
  readonly title: string;
  /** What the surface still does without it, so the absence names a next move. */
  readonly detail: string;
}

/** Mount a plan-owned body, or say plainly that it is reserved. */
export function WorkflowSlotMount(props: WorkflowSlotMountProps): React.JSX.Element {
  return (
    <div className="meridian-workflow__slot">
      {props.slot.body ?? (
        <Nothing kind="empty" placement="surface" title={props.title} detail={props.detail} />
      )}
    </div>
  );
}
