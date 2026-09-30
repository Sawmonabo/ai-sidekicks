// What the `run` partition's body carries and what it refuses: exactly the members the contract
// registers for the kind in hand (the derived union plus the per-type members of the four kinds
// that declare their own payload), nothing a payload invented, and each per-type member only on
// its own kind. The claimed kinds, the partition under every scenario and the fold across
// transitions are in `run-lifecycle-projector.test.ts`.

import { describe, expect, it } from "vitest";

import type { ExecutionPosture } from "@ai-sidekicks/contracts";

import type { ProjectedSessionEvent } from "../session/entities/entities.js";
import { projectRunLifecycleEvent } from "./run-lifecycle-projector.js";
import { SYNTHETIC_SESSION_ID } from "./run-lifecycle-projector.test-support.js";

/**
 * A posture in the contract's own shape, so the compiler holds the fixture to it. The
 * credential-policy reference belongs to a sandboxed mode and is a content-addressed digest;
 * a merely posture-looking fixture would pass the fold but be refused by the selector that
 * reads it.
 */
const SANDBOXED_POSTURE: ExecutionPosture = {
  mode: "workspace-sandboxed",
  networkAccess: "none",
  writableRoots: ["/workspace"],
  credentialPolicyRef: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
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
    // The composer's posture chip reads this member; it is carried whole and unparsed.
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
          targetPosition: 12,
        }),
      ),
    ).toStrictEqual({ runVersion: 4, targetPosition: 12 });

    expect(
      bodyOf(
        runEvent("run.interrupted", {
          runId: "run-1",
          newState: "interrupted",
          trigger: "budget_exhausted",
        }),
      ),
    ).toStrictEqual({ newState: "interrupted", trigger: "budget_exhausted" });
  });

  it("negative control: the old four-member body would fail every case above", () => {
    // The old projector kept only `runVersion`, the two states and `agentId`, dropping every
    // registered member beside them.
    const body = bodyOf(
      runEvent("run.running", {
        runId: "run-1",
        newState: "running",
        executionPosture: { mode: "trusted", networkAccess: "full", writableRoots: [] },
        trigger: "idle_timeout",
      }),
    );

    expect(Object.keys(body).sort()).toStrictEqual(["executionPosture", "newState", "trigger"]);
  });

  it("copies no member the registered shapes do not name", () => {
    // A payload member nothing registers is never read, so a key cannot widen the body.
    const body = bodyOf(
      runEvent("run.starting", {
        runId: "run-1",
        newState: "starting",
        speculativeMember: "should-not-travel",
        // Equal to the envelope's; a beat naming another session is refused before the body.
        sessionId: SYNTHETIC_SESSION_ID,
        timestamp: "2026-01-01T14:20:01.000Z",
      }),
    );

    expect(body).toStrictEqual({ newState: "starting" });
  });

  it("carries the creation row's linkage, run config, and admission stamps", () => {
    // Members of `run.queued` that neither `run.subscribeState` shape declares.
    expect(
      bodyOf(
        runEvent("run.queued", {
          runId: "run-1",
          runVersion: 1,
          newState: "queued",
          agentId: "agent-1",
          parentRunId: "run-0",
          internalHelper: false,
          reachedBy: "provider_subagent",
          effectiveRunConfig: { tokenLimit: 200_000 },
          admittedUnpricedCapUsdMicros: 5_000_000,
          admittedModelFamily: "claude",
          admittedProviderAccountId: "provider-account-1",
        }),
      ),
    ).toStrictEqual({
      runVersion: 1,
      newState: "queued",
      agentId: "agent-1",
      parentRunId: "run-0",
      internalHelper: false,
      reachedBy: "provider_subagent",
      effectiveRunConfig: { tokenLimit: 200_000 },
      admittedUnpricedCapUsdMicros: 5_000_000,
      admittedModelFamily: "claude",
      admittedProviderAccountId: "provider-account-1",
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

  it("carries each forward, non-state row's own registered members", () => {
    // Each of these kinds carries its own members beyond the counter.
    expect(
      bodyOf(
        runEvent("run.provider_initialized", {
          runId: "run-1",
          runVersion: 2,
          provider: "claude",
          model: "claude-opus-5",
        }),
      ),
    ).toStrictEqual({ runVersion: 2, provider: "claude", model: "claude-opus-5" });

    expect(
      bodyOf(runEvent("run.turn_started", { runId: "run-1", runVersion: 3, position: 17 })),
    ).toStrictEqual({ runVersion: 3, position: 17 });

    expect(
      bodyOf(
        runEvent("run.worker_shutdown", {
          runId: "run-1",
          runVersion: 4,
          reason: "provider worker restarting",
        }),
      ),
    ).toStrictEqual({ runVersion: 4, reason: "provider worker restarting" });
  });

  it("reads a per-type member off the kind that registers it and off no other", () => {
    // `provider`, `position`, `reason` and `reachedBy` are each registered on one row, so a
    // transition spelling them must not carry them.
    const body = bodyOf(
      runEvent("run.failed", {
        runId: "run-1",
        newState: "failed",
        failureCategory: "provider error",
        provider: "codex",
        model: "gpt-5.6",
        position: 17,
        reason: "not this row's member",
        reachedBy: "bridge_run",
        parentRunId: "run-0",
        admittedModelFamily: "claude",
        admittedProviderAccountId: "provider-account-1",
        resolvedAgent: { agentId: "agent-2" },
      }),
    );

    expect(body).toStrictEqual({ newState: "failed", failureCategory: "provider error" });
  });

  it("negative control: no per-type member is a second spelling of a derived one", () => {
    // Keeps the two tables disjoint: once a stream shape declares one of these members, the
    // per-type entry must be deleted.
    const derivedMembers = Object.keys(
      bodyOf(
        runEvent("run.interrupted", {
          runId: "run-1",
          runVersion: 9,
          previousState: "running",
          newState: "interrupted",
          agentId: "agent-1",
          targetPosition: 3,
          failureCategory: "provider error",
          recoveryCondition: "provider_unavailable",
          recoverySpanClassification: "complete",
          providerFailureDetail: "detail",
          completionKind: "turn",
          intendedClose: true,
          executionPosture: SANDBOXED_POSTURE,
          trigger: "idle_timeout",
        }),
      ),
    );

    // Non-empty, or the check below proves nothing.
    expect(derivedMembers.length).toBeGreaterThan(0);
    for (const perTypeMember of [
      "parentRunId",
      "internalHelper",
      "admittedUnpricedCapUsdMicros",
      "admittedModelFamily",
      "reachedBy",
      "effectiveRunConfig",
      "admittedProviderAccountId",
      "provider",
      "model",
      "position",
      "reason",
    ]) {
      expect(derivedMembers).not.toContain(perTypeMember);
    }
  });

  it("reads a wrong-shaped member as absent rather than carrying it", () => {
    // The store merges by spread, so a present `undefined` would erase earlier state.
    const body = bodyOf(
      runEvent("run.queued", {
        runId: "run-1",
        newState: "queued",
        executionPosture: ["not", "an", "object"],
        admittedUnpricedCapUsdMicros: Number.NaN,
        internalHelper: "true",
        resolvedAgent: { agentId: 7 },
      }),
    );

    expect(body).toStrictEqual({ newState: "queued" });
  });
});
