// The scripted-reply seam: a call that the scenario answers, or refuses by name.
//
// The claim this file holds is that the fixture bridge never turns a reply that failed
// to arrive into an absent value. An absent value renders as "there is none", which is
// a claim about the session that nothing checked.
//
// Every case drives the REAL scenario engine through the REAL bridge. A stand-in for
// either would pass over exactly the seam these cases hold: `abandoned` is a state only
// the engine's own teardown produces, and a hand-written double would be asserting its
// own arithmetic.

import { describe, expect, it } from "vitest";

import type { DaemonMethod } from "@ai-sidekicks/contracts";

import { FixtureBridgeError } from "./refusal.fixture.js";
import { createFixture } from "@renderer/console/bridge/fixture/call-plane/bridge.test-support.js";
import type { ScenarioReply } from "./scenario-reply.fixture.js";
import type { ConsoleScenario } from "@renderer/console/bridge/scenario/runtime/vocabulary.js";
import { STAND_IN_SESSION_ID, scenarioNamed } from "./vocabulary.test-support.js";

/**
 * The scenario every case below varies one member of.
 *
 * A stand-in rather than a corpus entry: `runtime/` imports no scenario from the corpus
 * above it, and what these cases need from a scenario is that it scripts NO reply — which
 * is the shape a stand-in states outright and a corpus entry only happens to have.
 */
const SEAM_BASE_SCENARIO: ConsoleScenario = scenarioNamed("scripted-reply-seam");

/** A scripted read whose reply these cases vary. */
const BRANCH_CONTEXT_CALL = "gitflow.branchContextRead";

/** Longer than one tick, so a reply parked on it is observably pending. */
const SCRIPTED_LATENCY_MS = 120;

/**
 * The branch context a scripted reply states, asserted verbatim so a stub cannot pass.
 *
 * FLAT, exactly as `BranchContextReadResponse` returns it — the context's fields ARE
 * the reply and there is no envelope member to wrap them in.
 */
const SCRIPTED_BRANCH_CONTEXT = {
  branchContextId: "branch-context-1",
  workspaceId: "workspace-1",
  baseBranch: "develop",
  headBranch: "feature/topic",
};

/** The entity-scoped call a computed reply in this file answers, and its two subjects. */
const MOUNT_READ_CALL = "repo.mountRead" as DaemonMethod;
const HEALTHY_MOUNT_ID = "9f2c4a10-1111-4000-8000-000000000001";
const UNREACHABLE_MOUNT_ID = "9f2c4a10-1111-4000-8000-000000000002";
const UNSCRIPTED_MOUNT_ID = "9f2c4a10-1111-4000-8000-000000000003";

/**
 * What each mount answers. Distinct values, so one cannot pass for the other.
 *
 * WHOLE `RepoMountReadResponse`s and not two-member stand-ins. `repo.mountRead` is
 * a method the corpus registers, so the fixture holds a scripted reply for it to
 * that shape (`fixture/call-plane/bridge.wire-contract.test.ts`) — and a scenario that could
 * answer it with `{id, health}` would be teaching every mount surface a frame the
 * daemon cannot send. Only `id` and `health.status` vary between the two, which is
 * what these cases read.
 */
const MOUNT_ANSWERS: Readonly<Record<string, unknown>> = {
  [HEALTHY_MOUNT_ID]: mountReadResponse(HEALTHY_MOUNT_ID, "healthy"),
  [UNREACHABLE_MOUNT_ID]: mountReadResponse(UNREACHABLE_MOUNT_ID, "unreachable"),
};

/** One registered mount-read reply, varying only in the two members these cases read. */
function mountReadResponse(repoMountId: string, status: "healthy" | "unreachable"): unknown {
  return {
    id: repoMountId,
    sessionId: STAND_IN_SESSION_ID,
    nodeId: "9f2c4a10-1111-4000-8000-000000000100",
    localPath: "/Users/probe/dev/ai-sidekicks",
    canonicalRoot: "/Users/probe/dev/ai-sidekicks",
    vcsType: "git",
    state: "attached",
    health: { status, checkedAt: "2026-01-01T14:20:00.500Z" },
    attachedAt: "2026-01-01T14:00:00.000Z",
  };
}

/** A scenario whose one reply is COMPUTED from the request rather than constant. */
function scenarioComputingMountRead(): ConsoleScenario {
  return {
    ...SEAM_BASE_SCENARIO,
    id: "computed-mount-read",
    replies: [
      {
        call: MOUNT_READ_CALL,
        // Reads the request rather than destructuring it: the request arrives as
        // `unknown`, and a computation that throws on a shape it did not expect is a
        // scenario bug that reaches the caller as one, past every refusal arm.
        resultFor: (request) => {
          if (typeof request !== "object" || request === null) {
            return undefined;
          }
          const { repoMountId } = request as { readonly repoMountId?: unknown };
          return typeof repoMountId === "string" ? MOUNT_ANSWERS[repoMountId] : undefined;
        },
      },
    ],
  };
}

/** A scenario answering the same call with one CONSTANT reply. The negative control. */
function scenarioConstantMountRead(): ConsoleScenario {
  return {
    ...SEAM_BASE_SCENARIO,
    id: "constant-mount-read",
    replies: [{ call: MOUNT_READ_CALL, result: MOUNT_ANSWERS[HEALTHY_MOUNT_ID] }],
  };
}

/**
 * A scenario whose branch-context read is scripted, optionally behind a latency.
 *
 * Built from the base above so the beats, the join order and the start instant are the
 * same for every case in this file — the only thing it varies is the reply.
 */
function scenarioScriptingBranchContext(afterMs?: number): ConsoleScenario {
  // The latency member is added only when there is one. `exactOptionalPropertyTypes`
  // is on, and a present-but-`undefined` `afterMs` is a different value from an absent
  // one — which is exactly the distinction the seam branches on.
  const reply: ScenarioReply =
    afterMs === undefined
      ? { call: BRANCH_CONTEXT_CALL, result: SCRIPTED_BRANCH_CONTEXT }
      : { call: BRANCH_CONTEXT_CALL, result: SCRIPTED_BRANCH_CONTEXT, afterMs };
  return { ...SEAM_BASE_SCENARIO, id: "scripted-branch-context", replies: [reply] };
}

describe("the fixture bridge's scripted calls — the same seam, rejecting instead", () => {
  it("rejects with the shared code when the engine is torn down under a call", async () => {
    const { bridge, engine } = createFixture(scenarioScriptingBranchContext(SCRIPTED_LATENCY_MS));
    const pending = bridge.desktopBridge.daemon.call(
      BRANCH_CONTEXT_CALL as DaemonMethod,
      undefined,
    );

    engine.dispose();

    // Same engine state, same code, different shape: a `DesktopBridge` method may
    // only resolve or reject, so the bridge rejects where the port returns an outcome.
    // A code that differed between the two would make the seam two seams.
    await expect(pending).rejects.toBeInstanceOf(FixtureBridgeError);
    await expect(pending).rejects.toMatchObject({
      refusal: { code: "reply-abandoned", origin: "fixture-bridge" },
    });
  });

  it("negative control: the same call resolves once the caller advances the clock", async () => {
    const { bridge } = createFixture(scenarioScriptingBranchContext());

    await expect(
      bridge.desktopBridge.daemon.call(BRANCH_CONTEXT_CALL as DaemonMethod, undefined),
    ).resolves.toStrictEqual(SCRIPTED_BRANCH_CONTEXT);
  });
});

describe("a computed reply — one call, one answer per entity", () => {
  it("answers each request with the entity that request named", async () => {
    // The defect this arm exists for: `replyFor` matches on the method NAME, so a
    // session holding two mounts asked twice and got the same mount back both times.
    // Both calls go through the real bridge, so what is asserted is what a surface
    // would have received.
    const { bridge } = createFixture(scenarioComputingMountRead());

    await expect(
      bridge.desktopBridge.daemon.call(MOUNT_READ_CALL, { repoMountId: HEALTHY_MOUNT_ID }),
    ).resolves.toStrictEqual(MOUNT_ANSWERS[HEALTHY_MOUNT_ID]);
    await expect(
      bridge.desktopBridge.daemon.call(MOUNT_READ_CALL, { repoMountId: UNREACHABLE_MOUNT_ID }),
    ).resolves.toStrictEqual(MOUNT_ANSWERS[UNREACHABLE_MOUNT_ID]);
  });

  it("refuses a request it scripts no answer for rather than resolving with an absence", async () => {
    // The rule the whole seam is built on: an absent value renders as "there is none",
    // which about a mount the scenario simply does not script is a claim nothing
    // checked. The scenario scripts the METHOD and not this entity, and the fixture's
    // own authoring refusal is what says so.
    const { bridge } = createFixture(scenarioComputingMountRead());

    const pending = bridge.desktopBridge.daemon.call(MOUNT_READ_CALL, {
      repoMountId: UNSCRIPTED_MOUNT_ID,
    });

    await expect(pending).rejects.toBeInstanceOf(FixtureBridgeError);
    await expect(pending).rejects.toMatchObject({
      refusal: { code: "reply-unscripted", origin: "fixture-bridge" },
    });
  });

  it("refuses a request that names no entity at all, rather than picking one", async () => {
    // A request carrying no id is a request the scenario answers for nothing, and the
    // seam says so. The alternative a fixture reaches for — answering with the table's
    // first row — is how a surface ships having only ever been drawn against one
    // entity, which is the whole defect this arm exists to close.
    const { bridge } = createFixture(scenarioComputingMountRead());

    await expect(
      bridge.desktopBridge.daemon.call(MOUNT_READ_CALL, undefined),
    ).rejects.toBeInstanceOf(FixtureBridgeError);
  });

  it("negative control: the constant form still answers every request the same way", async () => {
    // Without this, a seam that had made EVERY reply request-sensitive would pass the
    // three cases above while breaking every session-scoped read in the corpus.
    const { bridge } = createFixture(scenarioConstantMountRead());

    await expect(
      bridge.desktopBridge.daemon.call(MOUNT_READ_CALL, { repoMountId: HEALTHY_MOUNT_ID }),
    ).resolves.toStrictEqual(MOUNT_ANSWERS[HEALTHY_MOUNT_ID]);
    await expect(
      bridge.desktopBridge.daemon.call(MOUNT_READ_CALL, { repoMountId: UNSCRIPTED_MOUNT_ID }),
    ).resolves.toStrictEqual(MOUNT_ANSWERS[HEALTHY_MOUNT_ID]);
  });
});
