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

import type { WireErrorEnvelope } from "../../../../shared/wire-errors.js";
import type { ConsoleScenario } from "./scenario.js";

/**
 * The workflow identifiers one scenario's script can answer for.
 *
 * `undefined` on a member means the scenario scripts that read not at all. There is
 * then nothing to hold a request to, and the port's unscripted arm answers — which is
 * the refusal both snapshot reads already take.
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
    snapshotRunId: readStringMember(runRead?.result, "workflowRunId"),
    phaseOutputPhaseId: readStringMember(phaseOutputRead?.result, "phaseId"),
  };
}

/** What a workflow read is addressed by, where the two refuse differently. */
export type WorkflowSubjectKind = "run" | "phase";

/**
 * Refuse a run or a phase this scenario projects nothing for.
 *
 * Thrown rather than returned: the growth outcome union has no arm for a daemon
 * refusal on purpose — one would paraphrase the wire's own envelope — so a refusal
 * travels as a rejection here exactly as a scripted one does and as the live seam's
 * will once these become ordinary bridge calls.
 *
 * `workflow.not_found` is the workflow namespace's only registered not-found row;
 * minting a run-scoped one here would be a fixture teaching a surface a code the
 * corpus does not register, which is the one thing a fixture must never do.
 *
 * `declared` absent means the scenario scripts the read not at all, so there is
 * nothing to check and the unscripted arm — a refusal in both cases — answers
 * instead. A scenario that DOES script one is held to exactly the identifier its own
 * reply carries.
 */
export function requireScenarioWorkflowSubject(
  declared: string | undefined,
  requested: string,
  kind: WorkflowSubjectKind,
): void {
  if (declared === undefined || declared === requested) {
    return;
  }
  const refusal: WireErrorEnvelope = {
    code: "workflow.not_found",
    message: `No workflow ${kind} \`${requested}\` exists on this node.`,
  };
  throw refusal;
}

/**
 * One STRING member of a value that may not be an object at all.
 *
 * A scenario's `result` is deliberately untyped so it can carry any registered reply,
 * so an id lifted out of one is checked rather than asserted — the narrowing the
 * sibling derivations each do for what they read.
 */
function readStringMember(value: unknown, member: string): string | undefined {
  const read =
    typeof value === "object" && value !== null
      ? (value as Readonly<Record<string, unknown>>)[member]
      : undefined;
  return typeof read === "string" ? read : undefined;
}
