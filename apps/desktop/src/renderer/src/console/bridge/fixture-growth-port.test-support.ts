// What every fixture-growth-port suite needs before it can ask the port anything.
//
// One home for the three helpers more than one of the sibling suites uses: the
// operation caller that does not retype the signature table, the fixture's own
// port, and the scenario finder each refusal premise rests on. It holds nothing a
// single suite uses — a helper with one reader stays beside its reader.

import { createFixtureBridge } from "./fixture-bridge.js";
import type { GrowthOperationId } from "./growth-entry.js";
import type { GrowthOutcome } from "./growth-outcome.js";
import type { GrowthPort } from "./index.js";
import type { ConsoleScenario } from "./scenario.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";
import { WORKFLOWS_COMPLETED_PHASE_ID } from "./scenarios/workflow-fixture-phase-outputs.js";
import { WORKFLOWS_PARKED_RUN } from "./scenarios/workflow-fixture-runs.js";

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
 */
const PROBE_SUBJECTS: Partial<Record<GrowthOperationId, Readonly<Record<string, string>>>> = {
  workflowRunRead: { workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId },
  workflowPhaseOutputRead: {
    workflowRunId: WORKFLOWS_PARKED_RUN.workflowRunId,
    phaseId: WORKFLOWS_COMPLETED_PHASE_ID,
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
