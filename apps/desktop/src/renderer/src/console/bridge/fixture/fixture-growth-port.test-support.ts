// What every fixture-growth-port suite needs before it can ask the port anything.
//
// One home for the three helpers more than one of the sibling suites uses: the
// operation caller that does not retype the signature table, the fixture's own
// port, and the scenario finder each refusal premise rests on. It holds nothing a
// single suite uses — a helper with one reader stays beside its reader.

import { createFixtureBridge } from "./fixture-bridge.js";
import type { GrowthOperationId, GrowthOutcome } from "../growth-port/index.js";
import type { GrowthPort } from "../index.js";
import type { ConsoleScenario } from "../scenario-runtime/index.js";
import { FLAGSHIP_SCENARIO } from "../scenarios/flagship.js";
import { WORKFLOWS_SCENARIO_DEFINITIONS } from "../scenarios/workflow-fixture-definitions.js";
import { DEFINITION_RELEASE_CHECKS_SESSION } from "../scenarios/workflow-fixture-ids.js";
import { WORKFLOWS_COMPLETED_PHASE_ID } from "../scenarios/workflow-fixture-phase-outputs.js";
import { WORKFLOWS_PARKED_RUN } from "../scenarios/workflow-fixture-runs.js";

/**
 * The definition the two body reads are probed at, resolved out of the summary table.
 *
 * Resolved rather than restated, so the probe's version ordinal is the one the fixture
 * publishes: a literal here would go stale the first time that table moved a version
 * and the probe would then be asserting a refusal it had caused itself.
 */
const PROBE_DEFINITION = (() => {
  const definition = WORKFLOWS_SCENARIO_DEFINITIONS.find(
    (candidate) => candidate.id === DEFINITION_RELEASE_CHECKS_SESSION,
  );
  if (definition === undefined) {
    throw new Error("the workflows fixture no longer states the probed definition");
  }
  return definition;
})();

/**
 * Call one operation without knowing its request shape.
 *
 * The alternative — a table of one request per operation retyped here — is a second
 * declaration of the signature table that would go stale the first time a request
 * grew a member. So one request is sent to every arm, and an arm that declares no
 * `sessionId` simply never reads the member.
 *
 * The session is the scenario's OWN, and that is load-bearing rather than tidy: a
 * served operation may legitimately scope its answer to the session it is playing —
 * `callerParticipantRead` does, because an identity is a fact about one roster — so
 * a probe carrying no session would be asking about a session the fixture is not
 * playing and would read a correct scoping refusal as a broken served claim.
 *
 * Which is also why the session is a PARAMETER rather than a constant: the suites
 * drive more than one scenario, and a probe naming the flagship's session against a
 * bridge playing a different one would fail for exactly the reason above. The
 * flagship stays the default, so only a caller that means another scenario says so.
 */
export async function callOperation(
  port: GrowthPort,
  operationId: GrowthOperationId,
  sessionId: string = FLAGSHIP_SCENARIO.sessionId,
): Promise<GrowthOutcome<unknown>> {
  const call = port[operationId] as (request: unknown) => Promise<GrowthOutcome<unknown>>;
  return call({ sessionId, ...PROBE_SUBJECTS[operationId] });
}

/**
 * The identifiers a probe has to carry beyond a session id, per operation.
 *
 * A bare `{sessionId}` is not a valid request for every operation, and the sweep was
 * only getting away with it while the workflow handlers discarded what they were
 * addressed by. Now that they refuse a run or a phase their scenario projects nothing
 * for, a probe naming neither is a probe asking about `undefined` — so the sweep
 * supplies the workflows scenario's own identifiers and asks the question a caller
 * would ask. Operations addressed by a session alone stay absent from the table
 * rather than carrying an empty entry each.
 *
 * The values are not all strings: the version read is addressed by an ORDINAL beside
 * its definition id, so the entry type admits a number rather than making the one
 * numeric address here stringify into a request member the handler would then compare
 * against a number and never match.
 */
const PROBE_SUBJECTS: Partial<
  Record<GrowthOperationId, Readonly<Record<string, string | number>>>
> = {
  workflowRunRead: { workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId },
  workflowPhaseOutputRead: {
    workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId,
    phaseId: WORKFLOWS_COMPLETED_PHASE_ID,
  },
  // The version the parked run is pinned to, which is the only address this read
  // takes: it resolves a version id to the chain its definition holds, so a probe
  // naming a run or a session would be asking a question the request has no member
  // for.
  workflowVersionChainRead: { workflowVersionId: WORKFLOWS_PARKED_RUN.workflowVersionId },
  // The definition plane's two reads, addressed at the one definition this fixture
  // states a body for at the version the summary table publishes as its latest. A
  // probe naming another version number is a question this fixture refuses on purpose
  // — it holds one body per definition — so the ordinal is read from the same summary
  // row rather than written as a literal that would go stale the first time the
  // definition table moved a version.
  workflowDefinitionRead: { definitionId: PROBE_DEFINITION.id },
  workflowVersionRead: {
    definitionId: PROBE_DEFINITION.id,
    versionNumber: PROBE_DEFINITION.latestVersionNumber,
  },
};

/** The flagship scenario's fixture port, which is the port under test. */
export function fixturePort(): GrowthPort {
  const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
  return bridge.growth;
}

/**
 * Scenarios naming any of `members` anywhere — a beat payload or a scripted reply.
 *
 * Each refusal the fixture still answers with rests on a premise about what no
 * scenario says, and this is how that premise is asserted rather than restated:
 * the day a scenario does state one, the finder reports it and the refusal stops
 * being the honest answer.
 */
export function findScenariosNaming(
  scenarios: readonly ConsoleScenario[],
  members: readonly string[],
): readonly string[] {
  return scenarios
    .filter((scenario) => {
      const serialised = JSON.stringify(scenario);
      return members.some((member) => serialised.includes(`"${member}"`));
    })
    .map((scenario) => scenario.id);
}
