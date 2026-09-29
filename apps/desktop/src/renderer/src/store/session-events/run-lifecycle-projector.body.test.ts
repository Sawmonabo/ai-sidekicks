// What the `run` partition's BODY carries, and what it refuses.
//
// The projector used to keep `runVersion`, the two state strings, and `agentId`
// while claiming every run-lifecycle kind, so `executionPosture`, the
// stop-condition `trigger`, the run's provenance, the admission stamps, and
// the rollback `targetPosition` reached the timeline and never the `run`
// partition. The claim that follows from the repair is this file's subject:
//
//   • The body carries exactly the members the corpus registers for the kind in
//     hand — the two wire shapes' derived union, plus the per-type members the
//     four kinds that declare their own payload register, and nothing a payload
//     invented. Per-type means per type: a member registered on one row is read
//     off that row and off no other.
//
// The projector's claimed kinds, the partition under every scenario, and the fold
// across transitions are the sibling file's subject, `run-lifecycle-projector.test.ts`.

import { describe, expect, it } from "vitest";

import type { ExecutionPosture } from "@ai-sidekicks/contracts";

import type { ProjectedSessionEvent } from "../session/entities/entities.js";
import { projectRunLifecycleEvent } from "./run-lifecycle-projector.js";
import { SYNTHETIC_SESSION_ID } from "./run-lifecycle-projector.test-support.js";

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
 * Sequence 1 so a store initialized at cursor 0 reads it as the next event rather
 * than as a gap, which would degrade the store for a hole the case never had.
 */
function runEvent(kind: string, payload: Readonly<Record<string, unknown>>): ProjectedSessionEvent {
  return {
    id: "019b79ee-0280-7ea1-8110-e5e0d1150802",
    sessionId: SYNTHETIC_SESSION_ID,
    sequence: 1,
    kind,
    occurredAt: "2026-01-01T14:20:01.000Z",
    // The envelope's session, written into the payload rather than left off it,
    // because the fold requires the two to agree before it keys anything — the
    // durable `run_lifecycle` row registers `sessionId` and every case here is
    // about the BODY, not about a beat that names another session. A case may
    // still spell its own, and one below does.
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
          parentRunId: "run-0",
          internalHelper: false,
          admittedUnpricedCapCents: 500,
          admittedModelFamily: "claude",
        }),
      ),
    ).toStrictEqual({
      newState: "interrupted",
      trigger: "budget_exhausted",
      parentRunId: "run-0",
      internalHelper: false,
      admittedUnpricedCapCents: 500,
      admittedModelFamily: "claude",
    });
  });

  it("negative control: the old four-member body would fail every case above", () => {
    // Stated as its own case so the regression has a name. A projector that kept
    // only `runVersion`, the two states, and `agentId` folds this payload to a
    // body of exactly two members, and every registered member beside them is the
    // one a component was built to read.
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
        // Spelled explicitly, and equal to the envelope's: the claim is that the
        // body copies no member the shapes exclude, and a beat naming ANOTHER
        // session is refused before a body is ever read.
        sessionId: SYNTHETIC_SESSION_ID,
        timestamp: "2026-01-01T14:20:01.000Z",
      }),
    );

    expect(body).toStrictEqual({ newState: "starting" });
  });

  it("carries the creation row's provenance, run config, and paying account", () => {
    // The three members `run.queued` registers that neither `run.subscribeState`
    // shape declares. A body derived from those two shapes alone drops all three,
    // so the run a pane reads names no provenance, no admitted config, and no
    // account it will be billed against.
    expect(
      bodyOf(
        runEvent("run.queued", {
          runId: "run-1",
          runVersion: 1,
          newState: "queued",
          agentId: "agent-1",
          reachedBy: "provider_subagent",
          effectiveRunConfig: { turnLimit: 8 },
          admittedProviderAccountId: "provider-account-1",
        }),
      ),
    ).toStrictEqual({
      runVersion: 1,
      newState: "queued",
      agentId: "agent-1",
      reachedBy: "provider_subagent",
      effectiveRunConfig: { turnLimit: 8 },
      admittedProviderAccountId: "provider-account-1",
    });
  });

  it("carries each forward, non-state row's own registered members", () => {
    // The three kinds whose whole payload beyond the counter is per-type. Before
    // the per-type table each folded to a body of `runVersion` alone, so an
    // initialization report reached the partition naming neither provider nor
    // model, a turn boundary named no position, and a worker shutdown no reason.
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
    // The reason the second table is keyed by kind rather than merged into the
    // first. `provider`, `position`, `reason`, and `reachedBy` are each registered
    // on exactly one row, so a state transition spelling them is naming members
    // its own payload shape does not have — and a body that carried them would
    // hand a pane a provider, a turn position, and a provenance the wire never sent.
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
        admittedProviderAccountId: "provider-account-1",
      }),
    );

    expect(body).toStrictEqual({ newState: "failed", failureCategory: "provider error" });
  });

  it("negative control: no per-type member is a second spelling of a derived one", () => {
    // The gate on the two tables staying disjoint. The derived table is the two
    // registered shapes' own key union, so the day a contracts shape declares
    // `reachedBy` — or any other member below — this case fails and the per-type
    // entry is deleted rather than left to shadow the derivation it duplicates.
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
          parentRunId: "run-0",
          internalHelper: false,
          admittedUnpricedCapCents: 500,
          admittedModelFamily: "claude",
        }),
      ),
    );

    // Non-empty, or the intersection below is a claim about nothing.
    expect(derivedMembers.length).toBeGreaterThan(0);
    for (const perTypeMember of [
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
