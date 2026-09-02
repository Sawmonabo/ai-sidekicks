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
import type { GrowthOperationId } from "./growth-entry.js";
import { GROWTH_OPERATIONS } from "./growth-operations.js";
import { createLiveBridge } from "./live-bridge.js";
import type { ConsoleScenario } from "./scenario.js";
import { FIRST_RUN_SCENARIO } from "./scenarios/first-run.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";
import { createTier1Bridge } from "@ai-sidekicks/contracts";

describe("the fixture growth port — what it serves, and what it still refuses", () => {
  it("answers every operation its bridge claims to serve, and refuses every other", async () => {
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
    const served = new Set<string>(FIXTURE_SERVED_GROWTH_OPERATION_IDS);

    for (const operationId of Object.keys(GROWTH_OPERATIONS) as GrowthOperationId[]) {
      const outcome = await callOperation(bridge.growth, operationId);
      expect(outcome.status, `${operationId} answered the wrong way`).toBe(
        served.has(operationId) ? "served" : "unavailable",
      );
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
    const pausedScenario: ConsoleScenario = {
      ...FIRST_RUN_SCENARIO,
      id: "first-run-paused-probe",
      replies: FIRST_RUN_SCENARIO.replies.map((reply) =>
        reply.call === "session.read"
          ? {
              call: "session.read",
              result: {
                session: {
                  id: FIRST_RUN_SCENARIO.sessionId,
                  state: "paused",
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
    const bridge = createFixtureBridge({ scenario: pausedScenario });

    const outcome = await bridge.growth.sessionList({});

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value).toStrictEqual([
        { sessionId: pausedScenario.sessionId, state: "paused" },
      ]);
    }
  });
});
