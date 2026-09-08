// How a body this pane mounts tells the pane that the run has moved under it.
//
// THE RUN READ IS RE-ARMED BY SERVED ACTS AND BY FRAMES, and until this seam existed
// only one kind of act could reach it. `run-control-dispatch.ts` counts a served cancel
// or resume and the pane folds that count into the snapshot read's subject key; a served
// `workflowHumanFormSubmit` moved the run just as surely and advanced nothing, so a pane
// whose answer had been recorded by the daemon went on rendering the parked phase and
// its form until some other reason put the read again.
//
// THE MOUNT CONTRACT IS THE OWNER'S AND CANNOT CARRY THIS. `HumanFormSlot` renders its
// body as `<Body {...mount} />` and the mount is `slots/human-form-mount.ts`'s — what
// this pane owes the workflow plan's body and nothing else — so a console-local re-arm
// member added to it would widen a contract this console does not own. A context is the
// shape the corpus already uses at exactly this seam: `seats/pane-controls.ts` is the
// deck's own acts reaching the chrome it renders, for the same reason and with the same
// absence rule.
//
// AND IT CARRIES THE ACT RATHER THAN THE COUNT. What a body knows is that the daemon
// served its mutation; how many such acts there have been, and which read they re-arm,
// is the pane's. The round stays the ONE `servedActCount` the dispatcher already holds
// for this run — a second number for the pane to sum would be a second answer to how
// far behind the snapshot on screen is, and the two would agree only until one of them
// was advanced from somewhere the other could not see.
//
// `undefined` WHERE NO RUN PANE IS ABOVE, and deliberately not a no-op function. A body
// rendered outside this pane has no run read to re-arm, and a default that quietly did
// nothing would read identically to a pane that supplied one — the distinction
// `seats/pane-controls.ts` states at the same seam, for the same reason.

import { createContext, useContext } from "react";

/**
 * Record one act on this run that the daemon served.
 *
 * Advances the run read's re-arm round by exactly one, which puts exactly one further
 * read. It reports an act that HAPPENED and never a state: nothing the caller knows is
 * written into the snapshot, so what the pane shows next is the daemon's own answer
 * rather than a splice of the reply into the answer already in hand.
 */
export type RecordServedRunAct = () => void;

/**
 * The seam. `undefined` — not an act that does nothing — where no run pane is mounted.
 *
 * Held at the pane's own addressing on the provider's side, so an act recorded after
 * the pane was retargeted at another run is dropped rather than re-reading the run the
 * person moved to.
 */
export const ServedRunActContext: React.Context<RecordServedRunAct | undefined> = createContext<
  RecordServedRunAct | undefined
>(undefined);

/** The re-arm of the run pane this component is rendered inside, or `undefined`. */
export function useRecordServedRunAct(): RecordServedRunAct | undefined {
  return useContext(ServedRunActContext);
}
