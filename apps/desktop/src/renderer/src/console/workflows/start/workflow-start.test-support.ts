// What both of the picker's suites need before they can put a press.
//
// TWO SUITES, ONE SET OF SCAFFOLDING. `WorkflowStartMenu.test.tsx` is about what the
// menu lists, names and renders; `start-act.test.tsx` is about the window between a
// press and its answer. Both need the same two definitions and the same start held
// still, so that lives here rather than in whichever file was written first with the
// other deep-importing it.
//
// THE PORTS ARE THE CONSOLE'S OWN — `createRefusingGrowthPort` spread with the one
// operation a case is about — rather than objects shaped like a port. A stand-in would
// agree with whatever the surface did with it, and the refusing arm in particular is
// only meaningful because it is the refusal the real port composes.
//
// EACH FACTORY PUBLISHES ITS OPERATION AS WELL AS A WHOLE PORT. The menu's suite already
// holds a port answering the definition enumeration and needs only the start spliced
// into it; the act's suite needs the whole thing. Handing back both is one object rather
// than two factories that would have to agree about how a start behaves.

import { createRefusingGrowthPort } from "../../bridge/growth-port/growth-port.js";
import { growthUnavailableFromRejection, type GrowthPort } from "../../bridge/index.js";
import type { WireErrorEnvelope } from "../../core/index.js";
import type { WorkflowDefinitionRow } from "../definitions/definition-rows.js";
import { definition } from "../workflows-probe.test-support.js";

/** The definition a first press names. */
export const RELEASE_DEFINITION: WorkflowDefinitionRow = definition({
  id: "release",
  name: "Release checklist",
  scope: "session",
});

/** The second, so a list is a list and a second press can land on another row. */
export const AUDIT_DEFINITION: WorkflowDefinitionRow = definition({
  id: "audit",
  name: "Quarterly audit",
  scope: "project",
  latestWorkflowVersionId: "audit-version-7",
});

/** Both, in the order the enumeration carries them. */
export const START_DEFINITIONS: readonly WorkflowDefinitionRow[] = [
  RELEASE_DEFINITION,
  AUDIT_DEFINITION,
];

/** The refusal a scenario scripts as the daemon's, carried verbatim by the seam. */
const DAEMON_START_REFUSAL: WireErrorEnvelope = {
  code: "workflow.start_denied",
  message: "This participant may not start a workflow in this session.",
};

/** One `workflowRunStart` a case settles by hand, and what it was asked. */
export interface HeldWorkflowStart {
  /** The whole port, for a suite that needs nothing else answered. */
  readonly growth: GrowthPort;
  /** The one operation, for a suite splicing it into a port of its own. */
  readonly workflowRunStart: GrowthPort["workflowRunStart"];
  readonly requests: Parameters<GrowthPort["workflowRunStart"]>[0][];
  readonly serve: () => void;
  readonly rejectAsDaemon: () => void;
}

/**
 * A port whose start stays in flight until the case settles it.
 *
 * The window between dispatch and answer is where single flight and the disabled rows
 * both live, and a port that answered on the calling turn would close that window
 * before anything in it could be observed.
 */
export function heldStartPort(): HeldWorkflowStart {
  const requests: Parameters<GrowthPort["workflowRunStart"]>[0][] = [];
  let serveHeld: (() => void) | undefined;
  let rejectHeld: (() => void) | undefined;
  const workflowRunStart: GrowthPort["workflowRunStart"] = async (request) => {
    requests.push(request);
    return new Promise((resolve, reject) => {
      serveHeld = () => {
        resolve({
          status: "served",
          value: { workflowRunId: "019b7a12-run", state: "running", phaseStates: [] },
        });
      };
      rejectHeld = () => {
        reject(DAEMON_START_REFUSAL);
      };
    });
  };
  return {
    growth: { ...createRefusingGrowthPort(), workflowRunStart },
    workflowRunStart,
    requests,
    serve: () => serveHeld?.(),
    rejectAsDaemon: () => rejectHeld?.(),
  };
}

/** A start counted and answered, and what it was asked. */
export interface CountedWorkflowStart {
  readonly growth: GrowthPort;
  readonly requests: Parameters<GrowthPort["workflowRunStart"]>[0][];
}

/**
 * A port that answers every start with the refusal the seam composes.
 *
 * Built through the port's OWN rejection builder rather than as a literal: that builder
 * puts `call-rejected` on `code` and the daemon's envelope on `cause`, which is the arm
 * the daemon's word actually arrives on.
 */
export function refusingStartPort(): CountedWorkflowStart {
  const requests: Parameters<GrowthPort["workflowRunStart"]>[0][] = [];
  const workflowRunStart: GrowthPort["workflowRunStart"] = async (request) => {
    requests.push(request);
    return growthUnavailableFromRejection("workflowRunStart", DAEMON_START_REFUSAL);
  };
  return { growth: { ...createRefusingGrowthPort(), workflowRunStart }, requests };
}
