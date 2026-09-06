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
import { FIXTURE_SERVED_GROWTH_OPERATION_IDS } from "./fixture-growth-port.js";
import type { GrowthOperationId } from "../growth-port/growth-entry.js";
import { GROWTH_OPERATIONS } from "../growth-operations/index.js";
import { createLiveBridge } from "../live-bridge.js";
import type { ConsoleScenario } from "../scenario-runtime/scenario.js";
import { APPROVALS_SCENARIO } from "../scenarios/approvals.js";
import { FIRST_RUN_SCENARIO } from "../scenarios/first-run.js";
import { FLAGSHIP_SCENARIO } from "../scenarios/flagship.js";
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

describe("the fixture growth port — what it serves, and what it still refuses", () => {
  it("refuses every operation it does not serve, and names the unbuilt wire", async () => {
    // The `wire-unregistered` code is the instrument rather than the bare
    // `unavailable` status, and it has to be: a SERVED operation refuses too — for a
    // scenario that models nothing it could be answered from — so a status-only
    // reading cannot tell an unimplemented arm from an unscripted one, and an
    // operation that silently stopped being served would read as compliant.
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
    const served = new Set<string>(FIXTURE_SERVED_GROWTH_OPERATION_IDS);

    for (const operationId of Object.keys(GROWTH_OPERATIONS) as GrowthOperationId[]) {
      if (served.has(operationId)) {
        continue;
      }
      const outcome = await callOperation(bridge.growth, operationId);
      expect(outcome.status, `${operationId} answered the wrong way`).toBe("unavailable");
      if (outcome.status === "unavailable") {
        expect(outcome.code, `${operationId} refused with the wrong code`).toBe(
          "wire-unregistered",
        );
      }
    }
  });

  it("answers, or names the scenario's own gap, for every operation it serves", async () => {
    // The other side of the same claim. Over the flagship, five of the served
    // operations answer and the four approvals ones do not — that scenario models no
    // approvals — and what makes the second a served arm rather than an absent one is
    // that it refuses with the fixture's `reply-unscripted` and never with
    // `wire-unregistered`, which would send a reader to a document that owes a wire
    // this bridge already stands in for.
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
