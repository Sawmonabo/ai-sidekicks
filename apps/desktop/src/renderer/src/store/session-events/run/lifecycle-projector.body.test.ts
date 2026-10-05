// What the `run` partition's body carries and what it refuses: the execution posture a run
// stamps, the agent a creation binds, and no wrong-shaped member. The partition under every
// scenario and the fold across transitions are in `lifecycle-projector.test.ts`.

import { describe, expect, it } from "vitest";

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/driver";

import type { ProjectedSessionEvent } from "../../session/entities/entities.js";
import { projectRunLifecycleEvent } from "./lifecycle-projector.js";
import { SYNTHETIC_SESSION_ID } from "./lifecycle-projector.test-support.js";

/**
 * A posture in the contract's own shape, so the compiler holds the fixture to it. Every posture
 * carries a credential-policy reference; a merely posture-looking fixture would pass the fold but
 * be refused by the selector that reads it.
 */
const SANDBOXED_POSTURE: ExecutionPosture = {
  mode: "sandboxed",
  writableRoots: ["/workspace"],
  credentialPolicyRef: "policy://workspace",
};

/**
 * One synthetic run event, for payloads no scenario scripts. Sequence 1 reads as the next event
 * for a store at cursor 0, not as a gap.
 */
function runEvent(kind: string, payload: Readonly<Record<string, unknown>>): ProjectedSessionEvent {
  return {
    id: "019b79ee-0280-7ea1-8110-e5e0d1150802",
    sessionId: SYNTHETIC_SESSION_ID,
    sequence: 1,
    cursor: "cursor-at-1",
    kind,
    occurredAt: "2026-01-01T14:20:01.000Z",
    // The fold requires the payload's session to agree with the envelope's; a case may still
    // spell its own.
    payload: { sessionId: SYNTHETIC_SESSION_ID, ...payload },
  };
}

describe("the registered payload members the body carries", () => {
  /** The body one event folds to, or a failure naming what the projector answered. */
  function bodyOf(event: ProjectedSessionEvent): Readonly<Record<string, unknown>> {
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
    // Carried whole and unparsed.
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

  it("binds a run to the agent its creation starts from a saved definition", () => {
    // The row names its agent inside `resolvedAgent`; reading only `agentId` leaves it unbound.
    expect(
      bodyOf(
        runEvent("run.queued", {
          runId: "run-1",
          runVersion: 1,
          newState: "queued",
          resolvedAgent: { agentId: "agent-2", name: "Reviewer" },
        }),
      ),
    ).toStrictEqual({ runVersion: 1, newState: "queued", agentId: "agent-2" });
  });

  it("reads a wrong-shaped member as absent rather than carrying it", () => {
    // The store merges by spread, so a present `undefined` would erase earlier state.
    const body = bodyOf(
      runEvent("run.queued", {
        runId: "run-1",
        newState: "queued",
        executionPosture: ["not", "an", "object"],
        intendedClose: "true",
        resolvedAgent: { agentId: 7 },
      }),
    );

    expect(body).toStrictEqual({ newState: "queued" });
  });
});
