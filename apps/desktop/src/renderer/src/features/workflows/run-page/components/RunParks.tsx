// Every phase parked at the moment the run snapshot was built, as cards. The form route stays
// here because `formRoutePropsFor` has one caller and the rule that decides whether a wait is
// addressable governs only these cards. The parks are derived by `projectParkedPhases` in
// `runs/run-list-projection.ts`, shared with the run list, so both name a phase the same way.

import type {
  WorkflowPhaseState,
  WorkflowRunSnapshot,
} from "@renderer/services/wire-shapes/workflow-projection.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { ParkBadge } from "../../components/ParkBadge.js";
import type { WorkflowParkFormRoute } from "../../components/ParkFormRoute.js";
import { projectParkedPhases } from "../../runs/run-list-projection.js";
import type { WorkflowParkedPhase } from "../../runs/run-list-rows.js";
import { UNADDRESSABLE_HUMAN_WAIT_DETAIL, humanFormPhaseFor } from "../human-form-phase.js";
import type { HumanFormSelection } from "../hooks/useHumanFormSelection.js";

/**
 * Every phase parked at the moment the snapshot was built, and nothing else.
 *
 * A park is read from `parkReason`, never from a phase's `state` (the status union has no
 * suspended arm, and a phase that resumed carries no park members). A run with nothing parked
 * says so. Every card identifies its phase by `phaseId`, the value the graph node draws, so a
 * fan-out's cards can be told apart.
 */
export function RunParks(props: {
  /**
   * The served run, not its phases: a card's route to its own form names the run as well as the
   * phase.
   */
  readonly run: WorkflowRunSnapshot;
  readonly humanForms: HumanFormSelection;
}): React.JSX.Element {
  // Indexed by phase rather than zipped by position: the form route is decided from members the
  // projected entry deliberately does not carry, so each entry is paired with its wire phase.
  const parkedByPhaseId = new Map(
    projectParkedPhases(props.run.phaseStates).map((entry) => [entry.phaseId, entry]),
  );
  const parked = props.run.phaseStates.flatMap<{
    readonly entry: WorkflowParkedPhase;
    readonly phase: WorkflowPhaseState;
  }>((phase) => {
    const entry = parkedByPhaseId.get(phase.phaseId);
    return entry === undefined ? [] : [{ entry, phase }];
  });
  if (parked.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="inline"
        title="Nothing in this run is parked."
        detail="No phase is waiting on a person or on provider capacity right now."
      />
    );
  }
  return (
    <div className="meridian-workflow__parks">
      {parked.map(({ entry, phase }) => (
        // Keyed by the phase, the same value the graph draws on that phase's node.
        <ParkBadge
          key={entry.phaseId}
          parked={entry}
          // Spread on the arm that has one, not passed as `undefined`: the prop's presence says
          // the run pane can reach the phase's form.
          {...formRoutePropsFor(props.run.workflowRunId, phase, props.humanForms)}
        />
      ))}
    </div>
  );
}

/**
 * The route one park card offers to its own form, where the card has one.
 *
 * The pane mounts one form mount point, so every addressable wait offers the action that opens
 * its form and the card whose form is open says so. A wait reported without its handle says
 * why it cannot be opened. It returns a prop bag so the arm with no route omits the key.
 */
function formRoutePropsFor(
  workflowRunId: string,
  phase: WorkflowPhaseState,
  humanForms: HumanFormSelection,
): { readonly formRoute?: WorkflowParkFormRoute } {
  if (phase.parkReason !== "waiting-human") {
    return {};
  }
  if (humanFormPhaseFor(workflowRunId, phase) === undefined) {
    return { formRoute: { kind: "unaddressable", detail: UNADDRESSABLE_HUMAN_WAIT_DETAIL } };
  }
  const { phaseId } = phase;
  return humanForms.isOpen(phaseId)
    ? { formRoute: { kind: "open" } }
    : {
        formRoute: {
          kind: "openable",
          openForm: () => {
            humanForms.openFormFor(phaseId);
          },
        },
      };
}
