// What stands above the run pane's slots for one read state, and why it is four things.
//
// Split out of `WorkflowRunPane.tsx` when the park cards grew a route to their own
// forms: the chrome file owns the pane's address guards, its three absences and its
// slot mounts, and this file owns the rendering of one served snapshot. Two jobs, two
// files, per `apps/desktop/AGENTS.md`.
//
// EVERY ARM IS A DIFFERENT FACT AND NONE OF THEM IS THE OTHERS: nobody asked, the read
// is in flight, the port refused by name, or a snapshot arrived and the parks on it are
// what an operator came for. Collapsing any two is the conflation the five kinds of
// nothing exist to prevent.
//
// THE SERVED ARM MOUNTS TWO SIBLINGS AND DECIDES NOTHING ELSE. `RunPhaseGraph.tsx`
// draws the phases and `RunParks.tsx` draws the cards, each in its own module per the
// package's one-component-per-`.tsx` rule, and each reads park from the park members
// and never from a phase's `state` — the phase-state union carries no suspended arm on
// purpose, and the park members are live-scoped, present for exactly the phases parked
// when the response was built. Both obey that through the projection's own
// `phasePark`, and neither re-derives it.

import { Nothing, RefusalBanner } from "../../../primitives/index.js";
import { RunParks } from "./RunParks.js";
import { RunPhaseGraph } from "./RunPhaseGraph.js";
import type { WorkflowRunSnapshotState } from "./run-snapshot.js";
import type { HumanFormSelection } from "./human-form-selection.js";

/** What stands above the slots for one read state. */
export function RunReadState(props: {
  readonly snapshot: WorkflowRunSnapshotState;
  readonly humanForms: HumanFormSelection;
}): React.JSX.Element {
  const { snapshot } = props;
  switch (snapshot.status) {
    case "unasked":
      return (
        <Nothing
          kind="not-checked"
          placement="surface"
          title="This run has not been read in this window."
          detail="The run snapshot arrives from the daemon; nothing was asked of it here."
        />
      );
    case "reading":
      return <Nothing kind="not-loaded" placement="surface" title="Reading this run." />;
    case "unavailable":
      return <RefusalBanner {...snapshot.refusal} />;
    case "served":
      return (
        <>
          <RunPhaseGraph phases={snapshot.snapshot.phaseStates} />
          <RunParks run={snapshot.snapshot} humanForms={props.humanForms} />
        </>
      );
  }
}
