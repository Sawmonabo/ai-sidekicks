// The scripted-reply seam: a call that the scenario answers, or refuses by name. The fixture
// bridge never turns a reply that failed to arrive into an absent value, which would render as
// "there is none", a claim nothing checked. Every case drives the real scenario engine through the
// real bridge, since `abandoned` is a state only the engine's own teardown produces.

import { describe, expect, it } from "vitest";

import type { DaemonMethod, RepoMountId } from "@ai-sidekicks/contracts";

import { FixtureBridgeError } from "./refusal.fixture.js";
import { callBridge, createFixture } from "@test/helpers/fixture-bridge.js";
import type { ScenarioReply } from "./scenario-reply.fixture.js";
import type { Scenario } from "../../../../../fixtures/scenario.js";
import { FIXTURE_SCENARIO_SESSION_ID, scenarioNamed } from "./vocabulary.test-support.js";

/** The scenario every case below varies one member of: a stand-in that scripts no reply. */
const SEAM_BASE_SCENARIO: Scenario = scenarioNamed("scripted-reply-seam");

/** A scripted read whose reply these cases vary. */
const BRANCH_CONTEXT_CALL = "gitflow.branchContextRead";

/** Longer than one tick, so a reply parked on it is observably pending. */
const SCRIPTED_LATENCY_MS = 120;

/** The branch context a scripted reply states, flat as `BranchContextReadResponse` returns it. */
const SCRIPTED_BRANCH_CONTEXT = {
  branchContextId: "branch-context-1",
  workspaceId: "workspace-1",
  baseBranch: "develop",
  headBranch: "feature/topic",
};

/** The entity-scoped call a computed reply in this file answers, and its two subjects. */
const MOUNT_READ_CALL = "repo.mountRead" satisfies DaemonMethod;
const HEALTHY_MOUNT_ID = "9f2c4a10-1111-4000-8000-000000000001" as RepoMountId;
const UNREACHABLE_MOUNT_ID = "9f2c4a10-1111-4000-8000-000000000002" as RepoMountId;
const UNSCRIPTED_MOUNT_ID = "9f2c4a10-1111-4000-8000-000000000003" as RepoMountId;

/**
 * What each mount answers: whole `RepoMountReadResponse`s, since the fixture holds a registered
 * method's reply to its shape (`daemon.fixture.wire-contract.test.ts`). Only `id` and
 * `health.status` vary.
 */
const MOUNT_ANSWERS: Readonly<Record<string, unknown>> = {
  [HEALTHY_MOUNT_ID]: mountReadResponse(HEALTHY_MOUNT_ID, "healthy"),
  [UNREACHABLE_MOUNT_ID]: mountReadResponse(UNREACHABLE_MOUNT_ID, "unreachable"),
};

/** One registered mount-read reply, varying only in the two members these cases read. */
function mountReadResponse(repoMountId: string, status: "healthy" | "unreachable"): unknown {
  return {
    id: repoMountId,
    nodeId: "9f2c4a10-1111-4000-8000-000000000100",
    localPath: "/Users/probe/dev/ai-sidekicks",
    canonicalRoot: "/Users/probe/dev/ai-sidekicks",
    vcsType: "git",
    state: "attached",
    health: { status, checkedAt: "2026-01-01T14:20:00.500Z" },
    attachedAt: "2026-01-01T14:00:00.000Z",
    origin: {
      kind: "attached",
      repoMountId,
      projectId: "9f2c4a10-1111-4000-8000-000000000200",
    },
    displayName: "ai-sidekicks",
    usedBy: [{ sessionId: FIXTURE_SCENARIO_SESSION_ID }],
  };
}

/** A scenario whose one reply is COMPUTED from the request rather than constant. */
function scenarioComputingMountRead(): Scenario {
  return {
    ...SEAM_BASE_SCENARIO,
    id: "computed-mount-read",
    replies: [
      {
        call: MOUNT_READ_CALL,
        // Read, not destructured: the request is `unknown`, and a throw here would bypass every
        // refusal arm.
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
function scenarioConstantMountRead(): Scenario {
  return {
    ...SEAM_BASE_SCENARIO,
    id: "constant-mount-read",
    replies: [{ call: MOUNT_READ_CALL, result: MOUNT_ANSWERS[HEALTHY_MOUNT_ID] }],
  };
}

/** A scenario whose branch-context read is scripted, optionally behind a latency. */
function scenarioScriptingBranchContext(afterMs?: number): Scenario {
  // Added only when there is one: under `exactOptionalPropertyTypes` a present-but-`undefined`
  // `afterMs` differs from an absent one, which the seam branches on.
  const reply: ScenarioReply =
    afterMs === undefined
      ? { call: BRANCH_CONTEXT_CALL, result: SCRIPTED_BRANCH_CONTEXT }
      : { call: BRANCH_CONTEXT_CALL, result: SCRIPTED_BRANCH_CONTEXT, afterMs };
  return { ...SEAM_BASE_SCENARIO, id: "scripted-branch-context", replies: [reply] };
}

describe("the fixture bridge's scripted calls — the same seam, rejecting instead", () => {
  it("rejects with the shared code when the engine is torn down under a call", async () => {
    const { bridge, engine } = createFixture(scenarioScriptingBranchContext(SCRIPTED_LATENCY_MS));
    const pending = callBridge(bridge, BRANCH_CONTEXT_CALL);

    engine.dispose();

    // A `PlatformBridge` method may only resolve or reject; the code must match the port's.
    await expect(pending).rejects.toBeInstanceOf(FixtureBridgeError);
    await expect(pending).rejects.toMatchObject({
      refusal: { code: "reply-abandoned", origin: "fixture-bridge" },
    });
  });

  it("negative control: the same call resolves once the caller advances the clock", async () => {
    const { bridge } = createFixture(scenarioScriptingBranchContext());

    await expect(callBridge(bridge, BRANCH_CONTEXT_CALL)).resolves.toStrictEqual(
      SCRIPTED_BRANCH_CONTEXT,
    );
  });
});

describe("a computed reply — one call, one answer per entity", () => {
  it("answers each request with the entity that request named", async () => {
    // `replyFor` matches on the method name, so two mounts would get the same mount back.
    const { bridge } = createFixture(scenarioComputingMountRead());

    await expect(
      bridge.daemon.call(MOUNT_READ_CALL, { repoMountId: HEALTHY_MOUNT_ID }),
    ).resolves.toStrictEqual(MOUNT_ANSWERS[HEALTHY_MOUNT_ID]);
    await expect(
      bridge.daemon.call(MOUNT_READ_CALL, { repoMountId: UNREACHABLE_MOUNT_ID }),
    ).resolves.toStrictEqual(MOUNT_ANSWERS[UNREACHABLE_MOUNT_ID]);
  });

  it("refuses a request it scripts no answer for rather than resolving with an absence", async () => {
    // An absent value renders as "there is none", a claim nothing checked; the scenario
    // scripts the method and not this entity, and the authoring refusal says so.
    const { bridge } = createFixture(scenarioComputingMountRead());

    const pending = bridge.daemon.call(MOUNT_READ_CALL, {
      repoMountId: UNSCRIPTED_MOUNT_ID,
    });

    await expect(pending).rejects.toBeInstanceOf(FixtureBridgeError);
    await expect(pending).rejects.toMatchObject({
      refusal: { code: "reply-unscripted", origin: "fixture-bridge" },
    });
  });

  it("refuses a request that names no entity at all, rather than picking one", async () => {
    // Answering with the table's first row is how a view ships having only been drawn
    // against one entity.
    const { bridge } = createFixture(scenarioComputingMountRead());

    await expect(callBridge(bridge, MOUNT_READ_CALL)).rejects.toBeInstanceOf(FixtureBridgeError);
  });

  it("negative control: the constant form still answers every request the same way", async () => {
    // Without it, a seam that made every reply request-sensitive passes the cases above while
    // breaking every session-scoped read.
    const { bridge } = createFixture(scenarioConstantMountRead());

    await expect(
      bridge.daemon.call(MOUNT_READ_CALL, { repoMountId: HEALTHY_MOUNT_ID }),
    ).resolves.toStrictEqual(MOUNT_ANSWERS[HEALTHY_MOUNT_ID]);
    await expect(
      bridge.daemon.call(MOUNT_READ_CALL, { repoMountId: UNSCRIPTED_MOUNT_ID }),
    ).resolves.toStrictEqual(MOUNT_ANSWERS[HEALTHY_MOUNT_ID]);
  });
});
