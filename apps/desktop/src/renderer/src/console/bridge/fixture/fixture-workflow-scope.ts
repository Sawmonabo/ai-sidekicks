// Which workflow subjects one scenario's script can actually answer for.
//
// Split out of `fixture-growth-port.ts` on its neighbours' terms: the port owns the
// decision — which operations are served, and with which outcome — and this owns a
// derivation that fails in a way the port cannot. A scripted reply is matched by CALL
// NAME alone, so a port that passed a workflow request through untouched answered
// `workflow.runRead` for ANY run id with the one run its scenario states, and a
// phase-output read for any phase with that scenario's finished phase. That is one
// run's phases, parks and controls on screen under another run's name — a fixture
// teaching a surface that the daemon does not scope its answers.
//
// The scope is read OUT OF THE REPLIES rather than restated beside them, so a
// scenario that re-points either read cannot leave a stale id behind for a request to
// be validated against.
//
// AND IT IS ONLY A FIXED REPLY THAT NEEDS HOLDING. A `ScenarioComputedReply` is handed
// the request and picks its own answer, so it already answers per subject and there is
// nothing here to hold it to — the derivation below finds no declared id on such a
// reply and the port's check passes through. That is not a gap: a computed reply that
// holds no snapshot for a requested subject refuses with the constructor this module
// exports, so the refusal a caller meets is the same one either way. Which of the two
// mechanisms is in play is a property of the REPLY SHAPE and never of the call.

import type { WireErrorEnvelope } from "../../core/index.js";
import type { ConsoleScenario } from "../scenario-runtime/scenario.js";
import { readUnknownStringMember } from "../scenario-runtime/index.js";

/**
 * The workflow identifiers one scenario's FIXED replies can answer for.
 *
 * `undefined` on a member means there is nothing here to hold a request to, and it
 * covers the two ways that happens: the scenario scripts that read not at all, or it
 * scripts it as a computed reply that scopes itself. In the first case the port's
 * unscripted arm answers — the refusal both snapshot reads already take — and in the
 * second the computed reply answers, refusing an unheld subject with
 * `workflowSubjectNotFound` below.
 */
export interface DeclaredWorkflowScope {
  readonly snapshotRunId: string | undefined;
  readonly phaseOutputPhaseId: string | undefined;
}

export function declaredWorkflowScope(scenario: ConsoleScenario): DeclaredWorkflowScope {
  const runRead = scenario.replies.find((reply) => reply.call === "workflow.runRead");
  const phaseOutputRead = scenario.replies.find(
    (reply) => reply.call === "workflow.phaseOutputRead",
  );
  return {
    snapshotRunId: readUnknownStringMember(runRead?.result, "workflowRunId"),
    phaseOutputPhaseId: readUnknownStringMember(phaseOutputRead?.result, "phaseId"),
  };
}

/**
 * What a workflow read is addressed by, where each refuses differently.
 *
 * Three, because three reads on this seam are addressed by a subject that can be
 * absent: a run, a phase of one, and the version a run is pinned to. The last is
 * reached only from a computed reply — the chain read scopes itself — so it appears
 * in the refusal below and never in the FIXED-reply derivation above it.
 */
export type WorkflowSubjectKind = "run" | "phase" | "version";

/**
 * The refusal for a workflow subject a scenario holds nothing for.
 *
 * ONE CONSTRUCTOR FOR THE ONE FACT, reached from both sides of the scripted-reply
 * seam: the port's pre-check below holds a FIXED reply to the subject its own value
 * names, and a COMPUTED reply throws this itself for a subject its table does not
 * carry. Two spellings of one refusal would be a fixture whose message and code
 * depended on which reply shape a scenario happened to use.
 *
 * `workflow.not_found` is the workflow namespace's only registered not-found row;
 * minting a run-scoped one here would be a fixture teaching a surface a code the
 * corpus does not register, which is the one thing a fixture must never do.
 */
export function workflowSubjectNotFound(
  kind: WorkflowSubjectKind,
  requested: string,
): WireErrorEnvelope {
  return {
    code: "workflow.not_found",
    message: `No workflow ${kind} \`${requested}\` exists on this node.`,
  };
}

/**
 * Refuse a run or a phase this scenario's FIXED reply projects nothing for.
 *
 * Thrown rather than returned: the growth outcome union has no arm for a daemon
 * refusal on purpose — one would paraphrase the wire's own envelope — so a refusal
 * travels as a rejection here exactly as a scripted one does and as the live seam's
 * will once these become ordinary bridge calls.
 *
 * `declared` absent means there is nothing to hold the request to — the scenario
 * scripts the read not at all, or scripts it as a computed reply that scopes itself —
 * so this passes and the reply itself answers. A scenario that scripts a FIXED value
 * is held to exactly the identifier that value carries.
 */
export function requireScenarioWorkflowSubject(
  declared: string | undefined,
  requested: string,
  kind: WorkflowSubjectKind,
): void {
  if (declared === undefined || declared === requested) {
    return;
  }
  throw workflowSubjectNotFound(kind, requested);
}
