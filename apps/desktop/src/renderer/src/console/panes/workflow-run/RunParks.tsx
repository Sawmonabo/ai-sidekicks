// Every phase parked at the moment the run snapshot was built, as cards.
//
// A SIBLING RATHER THAN A SECOND COMPONENT IN `RunReadState.tsx`, for the reason
// `RunPhaseGraph.tsx` beside it states: one component per `.tsx`, reached by a deep
// relative import from its host and published through no door line.
//
// THE FORM ROUTE TRAVELS WITH THE CARDS. `formRoutePropsFor` has exactly one caller
// and it is the component below; splitting the two apart would leave the rule that
// decides whether a wait is addressable in one module and the only surface it governs
// in another.

import type { WorkflowPhaseState, WorkflowRunSnapshot } from "../../bridge/index.js";
import { Nothing } from "../../primitives/index.js";
import { ParkBadge } from "../../workflows/parks/ParkBadge.js";
import type { WorkflowParkFormRoute } from "../../workflows/parks/ParkFormRoute.js";
import { parkSchedule, phasePark } from "../../workflows/runs/run-list-projection.js";
import type { WorkflowParkedPhase } from "../../workflows/runs/run-list-projection.js";
import { PHASE_DISPLAY_NAME } from "./phase-display-name.js";
import {
  UNADDRESSABLE_HUMAN_WAIT_DETAIL,
  humanFormMountFor,
  type HumanFormSelection,
} from "./human-form-selection.js";

/**
 * The route one park card offers to its own form, where the card has one.
 *
 * A run that branches parks more than one phase on a person at a time, and the pane
 * mounts ONE form slot — so every addressable wait carries the action that makes its
 * form the open one, and the card whose form is already open says so instead. A wait
 * the run reported without its handle says why it cannot be opened, which is the fact
 * the operator needs and the one a missing control does not give them.
 *
 * Returns the prop bag rather than the route, so the arm with no route omits the key
 * instead of passing `undefined` through it — the mount's own presence rule.
 */
function formRoutePropsFor(
  workflowRunId: string,
  phase: WorkflowPhaseState,
  humanForms: HumanFormSelection,
): { readonly formRoute?: WorkflowParkFormRoute } {
  if (phase.parkReason !== "waiting-human") {
    return {};
  }
  if (humanFormMountFor(workflowRunId, phase) === undefined) {
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

/**
 * Every phase parked at the moment the snapshot was built, and nothing else.
 *
 * A park is read from `parkReason` and never from a phase's `state` — the status
 * union has no suspended arm and the park members are live-scoped, so a phase that
 * has resumed past its park carries none of them and must not be shown as waiting.
 * `phasePark` applies that discriminator once, in the projection, and this surface
 * never re-derives it.
 *
 * A run with nothing parked says so rather than rendering an empty region: "nothing
 * is waiting on anyone" is the answer an operator opened this pane for.
 *
 * EVERY CARD IDENTIFIES ITS PHASE. A run that branches parks more than one phase at
 * a time, and a stack of cards carrying only reason, cause and schedule leaves an
 * operator unable to tell which branch stopped — the two cards of a fan-out read
 * identically. The badge draws that identity from `phaseId`, which is the same value
 * the node above the cards draws, so a person reads one key in two places rather
 * than matching a card to a node by position.
 */
export function RunParks(props: {
  /**
   * The served run, not its phases: a card's route to its own form is the same mount
   * the slot below is handed, and that mount names the run as well as the phase.
   */
  readonly run: WorkflowRunSnapshot;
  readonly humanForms: HumanFormSelection;
}): React.JSX.Element {
  const parked = props.run.phaseStates.flatMap<{
    readonly entry: WorkflowParkedPhase;
    readonly phase: WorkflowPhaseState;
  }>((phase) => {
    const park = phasePark(phase);
    // Classified through the projection's own `parkSchedule` rather than by handing
    // the badge four wire members: whether a park resumes itself is not
    // `autoResumeAt`'s presence, and a second derivation of it here would be the
    // second authority the badge stopped being.
    //
    // `phaseName` is the badge's slot for an AUTHORED name and is left empty,
    // because this read carries none. The card is still identified: the badge draws
    // `phaseId` unconditionally, as a wire figure, which is what keeps a fan-out's
    // cards distinguishable without any surface inventing a name.
    return park === undefined
      ? []
      : [
          {
            entry: {
              phaseId: phase.phaseId,
              phaseName: PHASE_DISPLAY_NAME,
              park,
              schedule: parkSchedule(park),
            },
            phase,
          },
        ];
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
        // Keyed by the phase, which is the run's own identity for it, and the same
        // value the graph draws on that phase's node.
        <ParkBadge
          key={entry.phaseId}
          parked={entry}
          // Spread on the arm that has one and omitted on every other, rather than
          // passed as an explicit `undefined`: the prop's PRESENCE is what says this
          // surface can reach the phase's form, and a park waiting on provider
          // capacity has no form to reach at all.
          {...formRoutePropsFor(props.run.workflowRunId, phase, props.humanForms)}
        />
      ))}
    </div>
  );
}
