// Where a body another plan authors is mounted, and what stands there until it is.
//
// `owner-slots.ts` says who owns each of the five bodies; this is what the mount looks
// like while there is no body. The answer is the "reserved, not stubbed" rule: the
// surface says the feature has not been built, which is true, rather than drawing a
// shape that reads as a broken one.
//
// A BODY IS A COMPONENT, NEVER A CALL, AND THIS IS THE ONE PLACE THAT IS TRUE. React
// attributes a hook to whichever component is RENDERING when the hook runs, so a
// wrapper that invoked `body(mount)` inside its own render would put the body's hooks
// into the wrapper's hook list — and every one of these mounts is conditional, so that
// list would grow on the render where the branch is first taken, which is React's
// hook-order error. So this component CONSTRUCTS an element from the body and the
// mount it is handed, and a body that is absent is an absence rather than a call
// skipped. The five wrappers wrote that composition out five times; now they hand over
// their contract, their body and their mount and this file does it once. The
// reciprocal obligation is still the caller's: the body must be a stable reference,
// because a component composed inline on each render is a new type each time and
// React remounts it.
//
// THE CONTRACT IS CARRIED AND NEVER RENDERED. `contract` names governance work — a
// task id, a mount obligation, a deletion obligation — and the seat's own rule is that
// no console surface may display one. The copy a person sees is the caller's, written
// for a person. The contract travels anyway, because a mount that took only the body
// would let a sixth slot appear with nobody named against it — and it travels as the
// seat's OWN shape rather than as a member copied out of it: these props extend
// `OwnerSlotProps`, so the pair a mounting family renders a plan-owned slot with is
// declared once, in `seats/`, and read here. It used to be rebuilt into a local value
// whose `contract` nothing then consulted, which is the second activation route
// `owner-slots.ts` teaches against with the body member it deleted for the same
// reason.

import { Nothing } from "../primitives/index.js";
import type { OwnerSlotProps } from "../seats/index.js";

/**
 * What this mount is handed: the seat's own pair, plus what this family adds to it.
 *
 * `contract` and `body` are `OwnerSlotProps`' and are not restated — a mount that
 * spelled them again would be a second declaration of the shape `seats/owner-slot.ts`
 * exists to declare once, and it would go on compiling the day that one moved.
 */
export interface WorkflowSlotMountProps<TMount extends object> extends OwnerSlotProps<
  (mount: TMount) => React.ReactNode
> {
  /**
   * What the mounting surface hands the body — this slot's mount obligation.
   *
   * Absent where the surface cannot meet it, which is one slot's real state rather
   * than a convenience: the human form is opened from a phase, and a form composed
   * against a phase nobody resolved would be answerable in appearance and
   * unsubmittable in fact. No obligation, no body, and the reserved absence stands.
   */
  readonly mount: TMount | undefined;
  /** What is not here yet, in one sentence, written for a person. */
  readonly title: string;
  /** What the surface still does without it, so the absence names a next move. */
  readonly detail: string;
}

/** Mount a plan-owned body, or say plainly that it is reserved. */
export function WorkflowSlotMount<TMount extends object>(
  props: WorkflowSlotMountProps<TMount>,
): React.JSX.Element {
  const { body: SlotBody, mount } = props;
  return (
    <div className="meridian-workflow__slot">
      {SlotBody === undefined || mount === undefined ? (
        <Nothing kind="empty" placement="surface" title={props.title} detail={props.detail} />
      ) : (
        <SlotBody {...mount} />
      )}
    </div>
  );
}
