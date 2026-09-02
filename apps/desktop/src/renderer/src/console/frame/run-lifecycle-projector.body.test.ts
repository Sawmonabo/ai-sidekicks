// What the `run` partition's BODY carries, and what it refuses.
//
// The projector used to keep `runVersion`, the two state strings, and `agentId`
// while claiming every kind in the family, so `executionPosture`, the
// stop-condition `trigger`, the orchestration linkage, the admission stamps, and
// the rollback `targetPosition` reached the timeline and never the `run`
// partition. Two claims follow from the repair, and they are this file's subject:
//
//   • The body carries exactly the members the registered wire shapes name — no
//     fewer, and no member a payload invented.
//   • A carried member is READABLE where it lands. The fold and the selector that
//     reads it are two halves of one seam, so the end-to-end case drives a real
//     payload through the registered projectors into a real store and then reads
//     it back through the shipped selector.
//
// The projector's claimed kinds, the partition under every scenario, and the fold
// across transitions are the sibling file's subject, `run-lifecycle-projector.test.ts`.

import { describe, expect, it } from "vitest";

import type { ExecutionPosture } from "@ai-sidekicks/contracts";

import { SessionStore, type ConsoleSessionEvent } from "../store/index.js";
// Deep rather than barrelled because the store family publishes neither its entity
// type nor its selectors on a barrel, and a test file is not a subject of the
// layering DAG. The real selector, not a re-export of it: a local narrowing here
// would be checking this file's own copy of the thing under test.
import type { ConsoleEntity } from "../store/entities.js";
import { stampedExecutionPostureOf } from "../store/selectors.js";
import { RUN_LIFECYCLE_PROJECTORS, projectRunLifecycleEvent } from "./run-lifecycle-projector.js";

/** The session every synthetic event below is attributed to. */
const SYNTHETIC_SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a11a5";

/**
 * A posture in the contract's own shape, annotated so the compiler holds the
 * fixture to it. Both arms matter: the credential-policy reference belongs to a
 * SANDBOXED mode and never to `trusted`, and it is a content-addressed digest over
 * the policy artifact rather than the policy itself. A fixture that merely looked
 * posture-shaped would pass the fold — which carries a registered object whole —
 * and then be refused by the selector that reads it, silently.
 */
const SANDBOXED_POSTURE: ExecutionPosture = {
  mode: "workspace-sandboxed",
  networkAccess: "none",
  writableRoots: ["/workspace"],
  credentialPolicyRef: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
};

/**
 * One synthetic run event, so a case can drive a payload no scenario scripts.
 *
 * Sequence 1 so a store initialised at cursor 0 reads it as the next event rather
 * than as a gap, which would degrade the store for a hole the case never had.
 */
function runEvent(kind: string, payload: Readonly<Record<string, unknown>>): ConsoleSessionEvent {
  return {
    id: "019b79ee-0280-7ea1-8110-e5e0d1150802",
    sessionId: SYNTHETIC_SESSION_ID,
    sequence: 1,
    kind,
    occurredAt: "2026-01-01T14:20:01.000Z",
    payload,
  };
}

describe("the registered payload members the body carries", () => {
  /** The body one event folds to, or a failure naming what the projector answered. */
  function bodyOf(event: ConsoleSessionEvent): Readonly<Record<string, unknown>> {
    const [mutation] = projectRunLifecycleEvent(event);
    if (mutation?.operation !== "upsert") {
      throw new Error(`the projector answered no upsert for ${event.kind}`);
    }
    const { body } = mutation.entity;
    if (body === undefined) {
      throw new Error(`the projector folded ${event.kind} to an entity with no body`);
    }
    return body;
  }

  it("carries the execution posture a run.running payload stamps", () => {
    // The member the composer's posture chip reads. Carried whole and unparsed:
    // the console renders a registered object through its own consumer rather
    // than re-validating a shape the contract owns.
    expect(
      bodyOf(
        runEvent("run.running", {
          runId: "run-1",
          runVersion: 3,
          previousState: "starting",
          newState: "running",
          executionPosture: SANDBOXED_POSTURE,
        }),
      ),
    ).toStrictEqual({
      runVersion: 3,
      previousState: "starting",
      newState: "running",
      executionPosture: SANDBOXED_POSTURE,
    });
  });

  it("carries a rollback's target position and the stop condition that ended a run", () => {
    expect(
      bodyOf(
        runEvent("run.rolled_back", {
          runId: "run-1",
          runVersion: 4,
          channelId: "channel-1",
          targetPosition: 12,
        }),
      ),
    ).toStrictEqual({ runVersion: 4, channelId: "channel-1", targetPosition: 12 });

    expect(
      bodyOf(
        runEvent("run.interrupted", {
          runId: "run-1",
          newState: "interrupted",
          trigger: "budget_exhausted",
          parentRunId: "run-0",
          internalHelper: false,
          producingNodeId: "node-1",
          admittedUnpricedCapCents: 500,
          admittedModelFamily: "claude",
        }),
      ),
    ).toStrictEqual({
      newState: "interrupted",
      trigger: "budget_exhausted",
      parentRunId: "run-0",
      internalHelper: false,
      producingNodeId: "node-1",
      admittedUnpricedCapCents: 500,
      admittedModelFamily: "claude",
    });
  });

  it("negative control: the old four-member body would fail every case above", () => {
    // Stated as its own case so the regression has a name. A projector that kept
    // only `runVersion`, the two states, and `agentId` folds this payload to a
    // body of exactly two members, and every registered member beside them is the
    // one a surface was built to read.
    const body = bodyOf(
      runEvent("run.running", {
        runId: "run-1",
        newState: "running",
        executionPosture: { mode: "trusted", networkAccess: "full", writableRoots: [] },
        trigger: "idle_timeout",
        admittedModelFamily: "codex",
      }),
    );

    expect(Object.keys(body).sort()).toStrictEqual([
      "admittedModelFamily",
      "executionPosture",
      "newState",
      "trigger",
    ]);
  });

  it("copies no member the registered shapes do not name", () => {
    // The member list is the table's, so a payload member nothing registers is
    // never read — the guard against a fixture or a future daemon widening the
    // body by writing a key the console then renders as though it were contract.
    const body = bodyOf(
      runEvent("run.starting", {
        runId: "run-1",
        newState: "starting",
        speculativeMember: "should-not-travel",
        currentState: "starting",
        sessionId: "019b79ee-0280-75e5-8510-ada11a5a11a5",
        timestamp: "2026-01-01T14:20:01.000Z",
      }),
    );

    expect(body).toStrictEqual({ newState: "starting" });
  });

  it("reads a wrong-shaped member as absent rather than carrying it", () => {
    // Absence has to be absence: the store merges a body by spread, so a
    // present-but-undefined key erases what an earlier event established.
    const body = bodyOf(
      runEvent("run.running", {
        runId: "run-1",
        newState: "running",
        executionPosture: ["not", "an", "object"],
        admittedUnpricedCapCents: Number.NaN,
        internalHelper: "true",
      }),
    );

    expect(body).toStrictEqual({ newState: "running" });
  });
});

describe("a stamped posture, from the payload to the surface that reads it", () => {
  // The leg no fold case can cover on its own. `store/selectors.ts` reads
  // `executionPosture` off a run entity's body, and until this projector carried
  // the member the console had no producer for it anywhere — the selector was
  // correct and unreachable. Every half here is the shipped one: the registered
  // projectors, a real `SessionStore`, the real selector.

  const STAMPED_RUN_ID = "019b79ee-0280-7ea1-8110-e5e0d1150803";

  /** The run one `run.running` beat folds to, through the registered projectors. */
  function runStampedWith(executionPosture: unknown): ConsoleEntity | undefined {
    const store = new SessionStore({
      sessionId: SYNTHETIC_SESSION_ID,
      projectors: RUN_LIFECYCLE_PROJECTORS,
    });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    store.applyBatch([
      runEvent("run.running", {
        runId: STAMPED_RUN_ID,
        runVersion: 3,
        newState: "running",
        executionPosture,
      }),
    ]);

    const state = store.snapshot();
    expect(state.degradedCause).toBeUndefined();
    return state.partitions.run[STAMPED_RUN_ID];
  }

  it("hands the selector the posture the payload stamped", () => {
    const run = runStampedWith(SANDBOXED_POSTURE);

    // The stored object itself rather than a copy of it, which is what keeps the
    // read usable as a `useStore` selector under `Object.is` equality.
    expect(stampedExecutionPostureOf(run)).toBe(run?.body?.["executionPosture"]);
    expect(stampedExecutionPostureOf(run)).toStrictEqual(SANDBOXED_POSTURE);
  });

  it("negative control: a run whose payload stamped no posture reads as none", () => {
    const store = new SessionStore({
      sessionId: SYNTHETIC_SESSION_ID,
      projectors: RUN_LIFECYCLE_PROJECTORS,
    });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    store.applyBatch([runEvent("run.running", { runId: STAMPED_RUN_ID, newState: "running" })]);

    const run = store.snapshot().partitions.run[STAMPED_RUN_ID];

    expect(run?.state).toBe("running");
    expect(stampedExecutionPostureOf(run)).toBeUndefined();
  });

  it("negative control: an unrepresentable posture reaches the body and is refused there", () => {
    // The two halves have different jobs, and this is the case that proves it. The
    // fold carries a registered member whole rather than re-validating a shape the
    // contract owns, so a posture claiming `trusted` AND a credential-policy
    // reference — unrepresentable in the contract — lands in the body intact and
    // renders as no posture at all, because the selector is the boundary that
    // decides whether a stored value is the shape a surface's type says it is.
    const unrepresentable = {
      mode: "trusted",
      networkAccess: "full",
      writableRoots: ["/workspace"],
      credentialPolicyRef: SANDBOXED_POSTURE.credentialPolicyRef,
    };
    const run = runStampedWith(unrepresentable);

    expect(run?.body?.["executionPosture"]).toStrictEqual(unrepresentable);
    expect(stampedExecutionPostureOf(run)).toBeUndefined();
  });
});
