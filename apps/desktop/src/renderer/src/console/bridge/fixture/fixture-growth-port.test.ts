// What the fixture serves, and that its claim about it is true.
//
// Two claims travel separately and have to agree: the port ANSWERS two operations,
// and the bridge PUBLISHES a set naming them. The composition root reads the set
// synchronously to decide whether to build a registry that can read at all, so a
// set that over-claims would have the console bind a stream to a store nothing can
// initialise, and a set that under-claims would leave the whole store layer dormant
// against a fixture that was ready to feed it. Neither failure is visible in a
// surface: both render as a console that quietly shows nothing.
//
// So every operation on the port is called, and each answer is checked against the
// set rather than against a list retyped here — and the session reads a store is
// established from are driven beside it, because the served set says an operation
// answers and says nothing about what it answered.
//
// The three subjects that used to sit under this header have their own files, one
// per concern: `fixture-growth-port.attention.test.ts`,
// `fixture-growth-port.gitflow.test.ts`, and
// `fixture-growth-port.refusals.test.ts`.

import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "./fixture-bridge.js";
import { callOperation, fixturePort } from "./fixture-growth-port.test-support.js";
import {
  FIXTURE_SCRIPT_ONLY_GROWTH_OPERATION_IDS,
  FIXTURE_SERVED_GROWTH_OPERATION_IDS,
} from "./fixture-served-operations.js";
import { FIXTURE_SERVED_WORKFLOW_OPERATION_IDS } from "./fixture-workflow-reads.js";
import type { GrowthOperationId } from "../growth-port/growth-entry.js";
import { GROWTH_OPERATIONS } from "../growth-operations/index.js";
import { createLiveBridge } from "../live-bridge.js";
import type { ConsoleScenario } from "../scenario-runtime/scenario.js";
import { AGENTS_SCENARIO, AGENTS_SCENARIO_SWITCH_LATENCY_MS } from "../scenarios/agents.js";
import { APPROVALS_SCENARIO } from "../scenarios/approvals.js";
import { FIRST_RUN_SCENARIO } from "../scenarios/first-run.js";
import { FLAGSHIP_SCENARIO } from "../scenarios/flagship.js";
import { WORKFLOWS_SCENARIO } from "../scenarios/workflows.js";
import { createTier1Bridge } from "@ai-sidekicks/contracts";

/**
 * A scenario whose `session.read` reply declares `state`.
 *
 * The first-run scenario with its one reply rewritten, so the directory reads
 * through the shape a real scenario has. Local to this suite: the co-located
 * `fixture-session-directory.test.ts` drives the derivation directly and this one
 * drives it through the port, which is the seam each is about.
 */
function scenarioDeclaring(state: string): ConsoleScenario {
  return {
    ...FIRST_RUN_SCENARIO,
    id: `first-run-declaring-${state}`,
    replies: FIRST_RUN_SCENARIO.replies.map((reply) =>
      reply.call === "session.read"
        ? {
            call: "session.read",
            result: {
              session: {
                id: FIRST_RUN_SCENARIO.sessionId,
                state,
                config: {},
                metadata: {},
                createdAt: FIRST_RUN_SCENARIO.startedAtIso,
                updatedAt: FIRST_RUN_SCENARIO.startedAtIso,
              },
              timelineCursors: { latest: "first-run-cursor-1" },
            },
          }
        : reply,
    ),
  };
}

/**
 * The served operations whose answer depends on what the playing scenario states.
 *
 * Membership in the served set says the PORT implements an operation, not that every
 * scenario has something for it to answer with. The branch-context read is the one
 * such operation under the flagship scenario, which scripts none: the registered reply
 * is flat and carries no absence, so there is nothing honest to serve and the read
 * refuses. Named rather than left implicit in the sweep, which reaches only the
 * operations the port does NOT serve: without this set nothing would say out loud
 * that a served operation may still refuse, and the case below asserts that refusal
 * rather than merely leaving the operation unscanned.
 */
const SCENARIO_CONDITIONAL_SERVED_OPERATIONS: ReadonlySet<GrowthOperationId> = new Set([
  "gitflowBranchContextRead",
]);

/**
 * The subject-addressed workflow reads, derived from the two declarations rather than
 * retyped.
 *
 * The script-only subset names operations from two families and this pair of claims is
 * about one of them, so it is read as the intersection: a workflow read that stops
 * being subject-addressed leaves both claims below in the same edit that moves it.
 */
const SUBJECT_ADDRESSED_WORKFLOW_READS = FIXTURE_SERVED_WORKFLOW_OPERATION_IDS.filter(
  (operationId) =>
    (FIXTURE_SCRIPT_ONLY_GROWTH_OPERATION_IDS as readonly string[]).includes(operationId),
);

describe("the fixture growth port — what it serves, and what it still refuses", () => {
  it("refuses every operation it does not serve, and names the unbuilt wire", async () => {
    // The `wire-unregistered` code is the instrument rather than the bare
    // `unavailable` status, and it has to be: a SERVED operation refuses too — for a
    // scenario that models nothing it could be answered from — so a status-only
    // reading cannot tell an unimplemented arm from an unscripted one, and an
    // operation that silently stopped being served would read as compliant.
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
    // The script-only writes are held to a DIFFERENT code rather than subtracted:
    // they ARE implemented, and this scenario scripts none of them, so they refuse
    // for the reason their own declaration gives — a write with no scripted answer
    // has no honest empty state to serve. What that refusal may not say is that the
    // wire is unbuilt, which would send a reader to a document owing a wire this
    // bridge already stands in for; it names the SCENARIO's gap instead. The subset
    // is read from its own declaration, so an operation that stopped being
    // script-only changes arms here rather than going unchecked.
    const scriptOnly = new Set<string>(FIXTURE_SCRIPT_ONLY_GROWTH_OPERATION_IDS);
    const served = new Set<string>(FIXTURE_SERVED_GROWTH_OPERATION_IDS);

    for (const operationId of Object.keys(GROWTH_OPERATIONS) as GrowthOperationId[]) {
      if (served.has(operationId) && !scriptOnly.has(operationId)) {
        continue;
      }
      const outcome = await callOperation(bridge.growth, operationId);
      expect(outcome.status, `${operationId} answered the wrong way`).toBe("unavailable");
      if (outcome.status === "unavailable") {
        expect(outcome.code, `${operationId} refused with the wrong code`).toBe(
          scriptOnly.has(operationId) ? "reply-unscripted" : "wire-unregistered",
        );
      }
    }
  });

  it("answers, or names the scenario's own gap, for every operation it serves", async () => {
    // The other side of the same claim, and stated as a CLASS rather than as a count:
    // over the flagship some served operations answer and the rest — the approvals
    // ones, the branch-context read, and every script-only entry — refuse, because
    // that scenario scripts none of them. A tally of which is which would go stale the
    // next time a lane serves an operation, and nothing would report it. What is
    // asserted is the property that does not move: a served arm refuses with the
    // fixture's `reply-unscripted` and never with `wire-unregistered`, which would
    // send a reader to a document that owes a wire this bridge already stands in for.
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });

    for (const operationId of FIXTURE_SERVED_GROWTH_OPERATION_IDS) {
      const outcome = await callOperation(bridge.growth, operationId);
      if (outcome.status === "unavailable") {
        expect(outcome.code, `${operationId} refused as an unbuilt wire`).not.toBe(
          "wire-unregistered",
        );
      }
    }
  });

  it("answers all four approvals reads and mutations from the scenario that scripts them", async () => {
    // The positive control the flagship cannot give: without it the case above holds
    // over a port whose four approvals arms refuse under every scenario there is.
    const bridge = createFixtureBridge({ scenario: APPROVALS_SCENARIO });

    for (const operationId of [
      "approvalProjectionRead",
      "approvalRuleList",
      "approvalResolve",
      "approvalRuleRevoke",
    ] as const) {
      const outcome = await callOperation(bridge.growth, operationId, APPROVALS_SCENARIO.sessionId);
      expect(outcome.status, `${operationId} did not answer`).toBe("served");
    }
  });

  it("negative control: a script-only write DOES serve for the scenario that scripts it", async () => {
    // Without this the subtraction above would hold over a port whose write arms were
    // never implemented at all — every one of them would refuse for the right reason
    // and the wrong cause. The agents scenario scripts a configuration update on a
    // latency, so the frozen clock has to reach it before the answer lands.
    const bridge = createFixtureBridge({ scenario: AGENTS_SCENARIO });
    const settling = bridge.growth.agentConfigUpdate({
      agentId: "agent-architect",
      interruptAndSwitch: false,
    });

    bridge.scenarioEngine?.advance(AGENTS_SCENARIO_SWITCH_LATENCY_MS);

    const outcome = await settling;
    expect(outcome.status).toBe("served");
  });

  it("still refuses a served workflow read under a scenario that scripts no workflow", async () => {
    // The counter-arm the sweep above deliberately leaves out, and the one this header
    // used to promise from a suite that was never written. A served operation is a
    // claim about the PORT and not about the script: under the flagship, which scripts
    // no workflow at all, these reads have no subject to answer for — and the honest
    // answer is a refusal rather than an invented empty form, which would render "this
    // run has no phases" about a run nothing asked after.
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
    expect(SUBJECT_ADDRESSED_WORKFLOW_READS.length).toBeGreaterThan(0);

    for (const operationId of SUBJECT_ADDRESSED_WORKFLOW_READS) {
      const outcome = await callOperation(bridge.growth, operationId, FLAGSHIP_SCENARIO.sessionId);
      expect(outcome.status, `${operationId} answered for an unscripted run`).toBe("unavailable");
    }
  });

  it("negative control: a script-only READ does serve for the scenario that scripts it", async () => {
    // The read-side twin of the write control above, and the reason subtracting these
    // three from the sweep is not the same act as deleting their coverage. Without it
    // the subtraction would hold over reads that refuse under EVERY scenario — the
    // right answer under the flagship arrived at from a handler that never answers at
    // all — and no surface would say so.
    const bridge = createFixtureBridge({ scenario: WORKFLOWS_SCENARIO });

    for (const operationId of SUBJECT_ADDRESSED_WORKFLOW_READS) {
      const outcome = await callOperation(bridge.growth, operationId, WORKFLOWS_SCENARIO.sessionId);
      expect(outcome.status, `${operationId} did not answer for its own script`).toBe("served");
    }
  });

  it("refuses a served operation the playing scenario states nothing for", async () => {
    // The half the sweep above cannot make: an operation is in the served set because
    // the PORT implements it, and whether a given scenario has anything to answer with
    // is the scenario's business. The branch-context read is that case — the registered
    // reply is flat and carries no absence, so a scenario scripting none leaves nothing
    // honest to serve and the read takes the "not checked" refusal instead of a
    // fabricated empty context.
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });

    for (const operationId of SCENARIO_CONDITIONAL_SERVED_OPERATIONS) {
      expect(FIXTURE_SERVED_GROWTH_OPERATION_IDS).toContain(operationId);
      const outcome = await callOperation(bridge.growth, operationId);
      expect(outcome.status, `${operationId} answered the wrong way`).toBe("unavailable");
    }
  });

  it("publishes exactly the set it serves, so the synchronous decision is the true one", () => {
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });

    expect([...bridge.growthServedOperations].sort()).toStrictEqual(
      [...FIXTURE_SERVED_GROWTH_OPERATION_IDS].sort(),
    );
  });

  it("negative control: the live bridge serves none of them and names each one's own row", async () => {
    // Without this the sweep above would hold over a port that served everything.
    // The live arm is the one a release build takes, and it must still render the
    // `not-checked` absence for every wire the fixture answers.
    //
    // The expected row is read from the ledger rather than written out here. A
    // literal would have been right for exactly as long as the served set drew on
    // one slate row, and the assertion it makes — that a refusal attributes to the
    // row that owes ITS wire — is the ledger's claim, not this file's.
    const bridge = createLiveBridge(createTier1Bridge());

    expect([...bridge.growthServedOperations]).toStrictEqual([]);
    for (const operationId of FIXTURE_SERVED_GROWTH_OPERATION_IDS) {
      const outcome = await callOperation(bridge.growth, operationId);
      expect(outcome.status).toBe("unavailable");
      if (outcome.status === "unavailable") {
        expect(outcome.code).toBe("wire-unregistered");
        expect(outcome.slateRow).toBe(GROWTH_OPERATIONS[operationId].slateRow);
      }
    }
  });

  it("reads the base state a store can actually be initialised from", async () => {
    const port = fixturePort();

    const outcome = await port.sessionRead({ sessionId: FLAGSHIP_SCENARIO.sessionId });

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      // Cursor zero, so the store admits the scenario's first beat rather than
      // discarding a stream that starts below its base state.
      expect(outcome.value.cursor).toBe(0);
      expect(outcome.value.participantJoinLog).toStrictEqual(
        FLAGSHIP_SCENARIO.participantIdsInJoinOrder,
      );
    }
  });

  it("lends no session's join order to another, hue allocation keying on it", async () => {
    const port = fixturePort();

    const outcome = await port.sessionRead({ sessionId: "session-somebody-else" });

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value.participantJoinLog).toStrictEqual([]);
    }
  });

  it("lists the scenario's session, and names it by its identifier rather than inventing one", async () => {
    const port = fixturePort();

    const outcome = await port.sessionList({});

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      // The state is the one the scenario's own `session.read` reply declares,
      // read rather than assumed: the port used to hardcode `active` on the
      // premise that "a scenario plays one live session", which is exactly the
      // premise the first-run scenario is a counterexample to.
      expect(outcome.value).toStrictEqual([
        { sessionId: FLAGSHIP_SCENARIO.sessionId, state: "active" },
      ]);
    }
  });

  it("answers a first run with an empty directory, because it has no session yet", async () => {
    // The defect this replaces: the directory answered with the scenario's session
    // unconditionally, so the FIRST-RUN scenario — a fresh install whose whole
    // purpose is "no sessions, no agents, no history" — listed a session row on the
    // one surface whose committed screenshot baselines exist to pin the EMPTY kind
    // of nothing (`Spec-023 §Console Design (Meridian)` §The five kinds of nothing).
    //
    // Derived from what the scenario DECLARES rather than from which scenario it is:
    // first-run's `session.read` reply says `provisioning`, which is a session still
    // being created and not one the node has.
    const bridge = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });

    const outcome = await bridge.growth.sessionList({});

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      // Served-and-empty, not refused: the operation IS answered here, and what it
      // found is nothing. A refusal would render `not-checked`, which says the
      // console never asked.
      expect(outcome.value).toStrictEqual([]);
    }
  });

  it("carries the declared state through rather than relabelling it", async () => {
    // The negative control for the rule above. A port that simply answered empty
    // for every scenario, or that kept hardcoding one state, would satisfy the two
    // cases above; driving a scenario that declares a directory state OTHER than
    // `active` is what separates "read from the reply" from either.
    //
    // `archived` rather than the `paused` this case used to drive: `paused` is not
    // a member of the contract's `SessionState` union, so the old expectation
    // asserted a directory row no daemon can send and made an impossible payload
    // look deliberate. `archived` is registered and is equally not `active`, so the
    // control still separates the two implementations it was written to separate.
    const bridge = createFixtureBridge({ scenario: scenarioDeclaring("archived") });

    const outcome = await bridge.growth.sessionList({});

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value).toStrictEqual([
        { sessionId: FIRST_RUN_SCENARIO.sessionId, state: "archived" },
      ]);
    }
  });

  it("refuses a scenario whose declared state the contract does not register", async () => {
    // The other half of the same defect: the old filter admitted `paused`, so a
    // scenario could serve a row no wire returns. It is an authoring defect in
    // in-tree source, so the derivation refuses by name and the refusal reaches the
    // caller rather than being flattened into the empty directory a first run
    // legitimately produces — which is what an empty answer here would look like.
    const bridge = createFixtureBridge({ scenario: scenarioDeclaring("paused") });

    await expect(bridge.growth.sessionList({})).rejects.toThrow(/session-state-unregistered/u);
  });
});
