// How a body this pane mounts tells the pane that the run has moved under it.
//
// A served `workflowHumanFormSubmit` moves the run, but `useRunControlDispatch` counts only served
// cancels and resumes, so the pane would keep rendering the parked phase. The context carries the
// act, not a count: the dispatcher's one `servedActCount` stays the only round. It is a context
// because the human-form mount contract (`human-form-mount.ts`) must not gain a console-local
// member. `undefined`, not a no-op, where no run pane is above, so a missing re-arm is visible;
// `components/PaneFrame/pane-controls.ts` does the same.

import { createContext } from "react";

/**
 * Record one act on this run that the daemon served. Advances the re-arm round by one, which puts
 * one further read; it reports that an act happened, never a state, so the pane shows the
 * daemon's own answer and not a splice of the reply.
 */
export type RecordServedRunAct = () => void;

/**
 * The seam. `undefined` where no run pane is mounted. Held at the pane's own addressing, so an
 * act recorded after the pane was retargeted at another run is dropped.
 */
export const ServedRunActContext: React.Context<RecordServedRunAct | undefined> = createContext<
  RecordServedRunAct | undefined
>(undefined);
