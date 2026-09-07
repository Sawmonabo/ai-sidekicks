// The DIAGNOSTICS plane: what the machine reports about itself, and the three reads
// addressed by one named run.
//
// WHY THIS PLANE HAS A MODULE. `fixture-workflow-reads.ts` beside it states the shape —
// a plane whose answers need reasoning of their own leaves the port and takes its served
// ids with it, so the ids and the handlers stay one set with one home. This plane earns
// it on the size of that reasoning: five operations split two ways, and which side an
// operation falls on is the whole of what a reader has to understand before touching any
// of them. Holding them in the port also took that file past the package's split
// threshold.
//
// WHY ALL FIVE DIAGNOSTICS READS ARE SERVED, AND WHY FOUR OF THEM SCRIPT-ONLY
//
// The diagnostics page is five regions and every one of them was drawn against its
// own absence, because no operation existed to answer any of them. Serving the plane
// is what makes the page's real states reachable at all — a degraded component, a run
// the daemon suspects is stuck, a classified failure, a retention override in force —
// and none of those could be reached from a scenario, a screenshot, or a test while
// the whole plane refused.
//
// The ONE that answers under any scenario is the one whose empty form is a real daemon
// answer rather than a fabrication: the default redaction posture is a policy with no
// bucket overrides, outbound denied, and no retention override in force, which is the
// shape a fresh node is in.
//
// The other four are `FIXTURE_SCRIPT_ONLY`, and they fall on that side for the three
// reasons `fixture-served-operations.ts` enumerates. A failure detail and a stall
// reading are READS ADDRESSED BY A SUBJECT — each answers with facts about one named
// run, so an empty form would assert the run exists and has nothing wrong with it. The
// recovery request is a WRITE, whose synthesized receipt would tell the page the daemon
// moved a run no author ever declared. And the status read is a MEASUREMENT: its reply
// has to name one of three categories, so there is no empty form of it — a synthesized
// `healthy` reads as "nothing reported a problem" only if you do not look at what the
// wire made it say, which is that somebody checked this machine and it is fine. The
// cast bar's compact mark renders that verdict in every window, so the fabrication
// would not stay inside this page.
//
// The live bridge keeps refusing all five, so nothing a release build renders moves.

import { answerFromScriptedReply, answerScriptOnly } from "./fixture-scripted-answer.js";
import type { GrowthPort } from "../growth-port/index.js";
import type { ScenarioEngine } from "../scenario-runtime/scenario-engine.js";

/**
 * The five diagnostics operations the fixture answers.
 *
 * Declared here and spread into `FIXTURE_SERVED_GROWTH_OPERATION_IDS` next door, on
 * `FIXTURE_SERVED_WORKFLOW_OPERATION_IDS`' rule: the ids and the implementations below
 * are one set with one home, and a second tuple in the served module would agree with
 * this one until a read landed in only one of them.
 */
export const FIXTURE_SERVED_DIAGNOSTICS_OPERATION_IDS = [
  "healthStatusRead",
  "healthFailureDetailRead",
  "healthStuckRunInspect",
  "healthRecoveryActionRequest",
  "healthRedactionPolicyRead",
] as const;

/** One diagnostics operation the fixture serves. Derived, so the set has one home. */
export type FixtureServedDiagnosticsOperationId =
  (typeof FIXTURE_SERVED_DIAGNOSTICS_OPERATION_IDS)[number];

/**
 * The fixture's five diagnostics answers for one running scenario.
 *
 * `Pick` over the port rather than a shape of its own, on `fixtureWorkflowReads`'
 * reason: a handler whose signature drifts from the operation it serves is a compile
 * error here rather than a surface rendering a value no daemon sends.
 */
export function fixtureDiagnosticsReads(
  engine: ScenarioEngine,
): Pick<GrowthPort, FixtureServedDiagnosticsOperationId> {
  return {
    // The node's health, from a script and from nothing else. A health reading is a
    // MEASUREMENT, and an empty form would not be an absence but a claim: a reply
    // carrying `overall` has to say one of the three categories, and every one of
    // them asserts something about a node nobody probed.
    healthStatusRead: async (request) =>
      await answerScriptOnly(engine, "health.statusRead", "healthStatusRead", request),
    healthRedactionPolicyRead: async (request) =>
      answerFromScriptedReply(
        engine,
        "health.redactionPolicyRead",
        "healthRedactionPolicyRead",
        request,
        () => ({
          status: "served",
          value: { buckets: [], outboundDefault: "deny", retentionPolicyOverrideActive: false },
        }),
      ),
    healthFailureDetailRead: async (request) =>
      await answerScriptOnly(
        engine,
        "health.failureDetailRead",
        "healthFailureDetailRead",
        request,
      ),
    healthStuckRunInspect: async (request) =>
      await answerScriptOnly(engine, "health.stuckRunInspect", "healthStuckRunInspect", request),
    healthRecoveryActionRequest: async (request) =>
      await answerScriptOnly(
        engine,
        "health.recoveryActionRequest",
        "healthRecoveryActionRequest",
        request,
      ),
  };
}
