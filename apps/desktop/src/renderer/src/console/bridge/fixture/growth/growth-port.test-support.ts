// What every fixture-growth-port suite needs before it can ask the port anything.
//
// One home for the helpers more than one of the sibling suites uses: the operation
// caller that does not retype the signature table, the fixture's own port, the scenario
// finder each refusal premise rests on, and the served-outcome narrowing every plane
// suite performs. They are named rather than counted, because a helper reaching its
// second reader joins them in a diff that never reads this header. It holds nothing a
// single suite uses — a helper with one reader stays beside its reader.

import { createFixtureBridge } from "../call-plane/bridge.js";
import type { GrowthOperationId, GrowthOutcome } from "../../growth-port/index.js";
import type { GrowthPort } from "../../index.js";
import type { ConsoleScenario } from "../../scenario/runtime/index.js";
import { FLAGSHIP_SCENARIO } from "../../scenario/flagship/flagship.js";
import { WORKFLOWS_SCENARIO_DEFINITIONS } from "../../scenario/workflows/definitions.js";
import { DEFINITION_RELEASE_CHECKS_SESSION } from "../../scenario/workflows/ids.js";
import { WORKFLOWS_COMPLETED_PHASE_ID } from "../../scenario/workflows/phase-outputs.js";
import { WORKFLOWS_PARKED_RUN } from "../../scenario/workflows/runs.js";

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
 * `callerUserRead` does, because an identity is a fact about one roster — so
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

/** A stream handle no port has minted, so a leg naming it answers about a gap. */
const PROBE_INGEST_ID = "ingest-no-such-stream";

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
  // The ingest plane is a PROTOCOL, so three of its four legs are addressed by a stream
  // handle the previous leg minted. A sweep holds no such handle and cannot: it makes
  // one call per operation. So each leg is probed with the members its request actually
  // declares, and the two that name a stream name one this port has never opened —
  // which is a question the daemon has an answer for, and it is the answer they give.
  artifactIngestBegin: { fileName: "probe.md", declaredSizeBytes: 4 },
  artifactIngestWriteChunk: { ingestId: PROBE_INGEST_ID, sequenceNumber: 0, chunk: "AAAA" },
  artifactIngestComplete: { ingestId: PROBE_INGEST_ID },
  artifactIngestAbort: { ingestId: PROBE_INGEST_ID },
};

/** How one probed operation settled, including the arm an outcome cannot express. */
export type OperationSettlement =
  | { readonly kind: "outcome"; readonly outcome: GrowthOutcome<unknown> }
  | { readonly kind: "wire-refusal"; readonly code: string };

/**
 * Call one operation and report how it settled, a thrown wire envelope included.
 *
 * WHY THE THROWN ARM EXISTS AT ALL. A fixture answering for the daemon refuses the way
 * the daemon does — by throwing the wire's own envelope — wherever a surface reads the
 * daemon's code rather than the console's: `sessionRead` does it for the unresolvable
 * resume cursor, and the ingest plane does it for every refusal the artifact plane names,
 * because the client's own normalizer keeps a typed envelope's code verbatim and
 * paraphrasing it into a growth code would teach the surface a shape the live seam
 * never sends. A sweep that only awaited outcomes would report that as an unhandled
 * error, so the settlement is a union rather than a single arm.
 *
 * The code is read off the envelope rather than trusted from the throw: a rejection
 * carrying no code is not a refusal and is re-thrown, which is what keeps a genuine
 * defect in a handler from being read as the daemon saying no.
 */
export async function settleOperation(
  port: GrowthPort,
  operationId: GrowthOperationId,
  sessionId: string = FLAGSHIP_SCENARIO.sessionId,
): Promise<OperationSettlement> {
  try {
    return { kind: "outcome", outcome: await callOperation(port, operationId, sessionId) };
  } catch (rejection: unknown) {
    const code = (rejection as { readonly code?: unknown }).code;
    if (typeof code !== "string") {
      throw rejection;
    }
    return { kind: "wire-refusal", code };
  }
}

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

/**
 * Scenarios stating a callback tool, under whatever member name they spell it.
 *
 * A STRUCTURAL READING RATHER THAN A NAME CENSUS, because the name census is now
 * wrong. It banned any scenario carrying `inputSchema` anywhere, which was a workable
 * proxy while a tool was the only thing in this fixture that had one — and a phase
 * parked on a person carries the schema its own form is drawn from, so the proxy now
 * reports a scenario that states no tool at all. What makes a callback tool a callback
 * tool is the PAIR: a name to invoke it by beside the schema its arguments take, or
 * the registry member the reply would carry it in. A phase's form schema has neither,
 * and a tool spelled into some other member still has the first.
 *
 * Walks the whole scenario — beat payloads and scripted replies alike — because the
 * premise being asserted is about what no scenario says anywhere, not about where.
 */
export function findScenariosStatingCallbackTool(
  scenarios: readonly ConsoleScenario[],
): readonly string[] {
  return scenarios
    .filter((scenario) => statesCallbackTool(scenario))
    .map((scenario) => scenario.id);
}

/**
 * The value a served outcome carries, or a failure naming what the port answered.
 *
 * Hoisted here on its second reader rather than copied: the plane suites beside the
 * port all narrow the same union the same way, and a second copy would report a
 * refusal as an unhelpful `undefined` in whichever suite drifted.
 */
export function servedValueOf<TValue>(outcome: GrowthOutcome<TValue>): TValue {
  if (outcome.status !== "served") {
    throw new Error(`the fixture port answered ${outcome.status} rather than serving a value`);
  }
  return outcome.value;
}

/** Whether this value, or anything under it, is a stated callback tool. */
function statesCallbackTool(candidate: unknown): boolean {
  if (Array.isArray(candidate)) {
    return candidate.some(statesCallbackTool);
  }
  if (typeof candidate !== "object" || candidate === null) {
    return false;
  }
  const members = candidate as Record<string, unknown>;
  // The registry member itself, which is what the reply would carry a tool list in.
  if ("callbackTools" in members) {
    return true;
  }
  // And the tool's own shape under any other spelling: a name beside a schema.
  if (typeof members["name"] === "string" && "inputSchema" in members) {
    return true;
  }
  return Object.values(members).some(statesCallbackTool);
}
