// One seam, two consumers, and the rule both of them owe.
//
// `scripted-reply.ts` exists because the fixture bridge and the fixture growth port
// answer request/response calls the same way and used to do it in one place the other
// could not reach. The claim this file holds is not that the seam has a function — it
// is that the two surfaces produce the SAME three refusal codes from the same engine
// states, and that neither of them ever turns a reply that failed to arrive into an
// absent value. An absent value renders as "there is none", which is a claim about the
// session that nothing checked.
//
// Every case drives the REAL scenario engine through the REAL bridge and the REAL
// port. A stand-in for either would pass over exactly the seam these cases hold:
// `abandoned` and `backlog-full` are states only the engine's own teardown and its own
// cap produce, and a hand-written double would be asserting its own arithmetic.

import { describe, expect, it } from "vitest";

import type { DaemonMethod } from "@ai-sidekicks/contracts";

import { SCENARIO_PENDING_REPLY_CAP } from "../core/index.js";
import { createFixtureBridge, FixtureBridgeError } from "./fixture-bridge.js";
import { GROWTH_PORT_REFUSAL_CODES, type GrowthOutcome } from "./growth-outcome.js";
import type { GrowthPort } from "./growth-port.js";
import { createLiveBridge } from "./live-bridge.js";
import type { ScenarioEngine } from "./scenario-engine.js";
import type { ConsoleScenario, ScenarioReply } from "./scenario.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";
import { SCRIPTED_REPLY_REFUSAL_CODES } from "./scripted-reply.js";
import { createTier1Bridge } from "@ai-sidekicks/contracts";

/** The one growth operation the fixture serves that reads through the seam today. */
const BRANCH_CONTEXT_CALL = "gitflow.branchContextRead";

/** Longer than one tick, so a reply parked on it is observably pending. */
const SCRIPTED_LATENCY_MS = 120;

/** The branch context a scripted reply states, asserted verbatim so a stub cannot pass. */
const SCRIPTED_BRANCH_CONTEXT = {
  branchContext: {
    branchContextId: "branch-context-1",
    workspaceId: "workspace-1",
    baseBranch: "develop",
    headBranch: "feature/topic",
  },
};

/** The request every branch-context read in this file makes. */
const BRANCH_CONTEXT_REQUEST = { workspaceId: "workspace-1", worktreeId: "worktree-1" };

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
 * that shape (`fixture-bridge.wire-contract.test.ts`) — and a scenario that could
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
    sessionId: FLAGSHIP_SCENARIO.sessionId,
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
    ...FLAGSHIP_SCENARIO,
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
    ...FLAGSHIP_SCENARIO,
    id: "constant-mount-read",
    replies: [{ call: MOUNT_READ_CALL, result: MOUNT_ANSWERS[HEALTHY_MOUNT_ID] }],
  };
}

/**
 * A scenario whose branch-context read is scripted, optionally behind a latency.
 *
 * Built from the flagship scenario rather than from a hand-written one so the beats,
 * the join order and the start instant are the same script every other fixture case
 * runs against — the only thing this file varies is the reply.
 */
function scenarioScriptingBranchContext(afterMs?: number): ConsoleScenario {
  // The latency member is added only when there is one. `exactOptionalPropertyTypes`
  // is on, and a present-but-`undefined` `afterMs` is a different value from an absent
  // one — which is exactly the distinction the seam branches on.
  const reply: ScenarioReply =
    afterMs === undefined
      ? { call: BRANCH_CONTEXT_CALL, result: SCRIPTED_BRANCH_CONTEXT }
      : { call: BRANCH_CONTEXT_CALL, result: SCRIPTED_BRANCH_CONTEXT, afterMs };
  return { ...FLAGSHIP_SCENARIO, id: "scripted-branch-context", replies: [reply] };
}

interface ScriptedFixture {
  readonly port: GrowthPort;
  readonly engine: ScenarioEngine;
}

function fixtureFor(scenario: ConsoleScenario): ScriptedFixture {
  const bridge = createFixtureBridge({ scenario });
  return { port: bridge.growth, engine: engineOf(bridge) };
}

/** The engine a fixture bridge built. Optional on the contract; never absent here. */
function engineOf(bridge: ReturnType<typeof createFixtureBridge>): ScenarioEngine {
  const engine = bridge.scenarioEngine;
  if (engine === undefined) {
    throw new Error("the fixture bridge built no scenario engine, so there is nothing to drive");
  }
  return engine;
}

function readBranchContext(fixture: ScriptedFixture): Promise<GrowthOutcome<unknown>> {
  return fixture.port.gitflowBranchContextRead(BRANCH_CONTEXT_REQUEST);
}

describe("the scripted-reply seam — one classification, two refusal vocabularies", () => {
  it("declares the two non-arrival codes once and both vocabularies spread them in", () => {
    // The property, not the spelling: each code the seam declares is a member of the
    // growth port's closed set. A test that retyped the three strings would pass while
    // the two sets drifted, which is the failure the spread exists to make impossible.
    for (const code of SCRIPTED_REPLY_REFUSAL_CODES) {
      expect(GROWTH_PORT_REFUSAL_CODES).toContain(code);
    }
    expect(GROWTH_PORT_REFUSAL_CODES).toContain("wire-unregistered");
  });
});

describe("the fixture growth port's scripted reads — served, refused, or named", () => {
  it("answers the absence when the scenario scripts no reply at all", async () => {
    // Unscripted is not a failure on this port: the operation IS answered, and what it
    // found is nothing. The flagship scenario scripts no branch-context reply, which is
    // what makes this the arm that runs for every shipped scenario today.
    const outcome = await readBranchContext(fixtureFor(FLAGSHIP_SCENARIO));

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value).toStrictEqual({ branchContext: undefined });
    }
  });

  it("serves the scripted reply when a scenario states one", async () => {
    const outcome = await readBranchContext(fixtureFor(scenarioScriptingBranchContext()));

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value).toStrictEqual(SCRIPTED_BRANCH_CONTEXT);
    }
  });

  it("holds a scripted latency pending until the caller advances the frozen clock", async () => {
    const fixture = fixtureFor(scenarioScriptingBranchContext(SCRIPTED_LATENCY_MS));
    let settled = false;
    const pending = readBranchContext(fixture).then((outcome) => {
      settled = true;
      return outcome;
    });

    await Promise.resolve();
    // The read is a request, not a tick. A port that spent the latency itself would
    // have no loading window and would deliver every beat inside the delay as a side
    // effect of a read.
    expect(settled).toBe(false);
    expect(fixture.engine.pendingReplyCount).toBe(1);
    expect(fixture.engine.progress.elapsedMs).toBe(0);

    fixture.engine.advance(SCRIPTED_LATENCY_MS);

    await expect(pending).resolves.toStrictEqual({
      status: "served",
      value: SCRIPTED_BRANCH_CONTEXT,
    });
  });

  it("refuses by name when the engine is torn down under a pending read", async () => {
    const fixture = fixtureFor(scenarioScriptingBranchContext(SCRIPTED_LATENCY_MS));
    const pending = readBranchContext(fixture);

    fixture.engine.dispose();

    // The rule the code exists for: a reply that never arrived reaches the surface as a
    // refusal it can render, never as `{branchContext: undefined}` — which would say
    // this workspace has no branch context, a fact nothing checked.
    const outcome = await pending;
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.code).toBe("reply-abandoned");
      expect(outcome.origin).toBe("growth-port");
      expect(outcome.operationId).toBe("gitflowBranchContextRead");
      expect(outcome.detail).toContain("torn down");
    }
    expect(outcome).not.toHaveProperty("value");
  });

  it("refuses by name once the pending backlog is full rather than growing unbounded", async () => {
    const fixture = fixtureFor(scenarioScriptingBranchContext(SCRIPTED_LATENCY_MS));
    const held = Array.from({ length: SCENARIO_PENDING_REPLY_CAP }, () =>
      readBranchContext(fixture),
    );

    const overflowing = await readBranchContext(fixture);

    expect(overflowing.status).toBe("unavailable");
    if (overflowing.status === "unavailable") {
      expect(overflowing.code).toBe("reply-backlog-full");
      expect(overflowing.operationId).toBe("gitflowBranchContextRead");
    }
    expect(fixture.engine.pendingReplyCount).toBe(SCENARIO_PENDING_REPLY_CAP);

    fixture.engine.advance(SCRIPTED_LATENCY_MS);
    for (const outcome of await Promise.all(held)) {
      expect(outcome.status).toBe("served");
    }
  });

  it("negative control: the same read under the same cap still serves when advanced", async () => {
    // Without this, a port that refused every scripted read would pass both refusal
    // cases above. The cap is reached and then RELEASED, so the two refusals are shown
    // to be states of the engine rather than the port's only answer.
    const fixture = fixtureFor(scenarioScriptingBranchContext(SCRIPTED_LATENCY_MS));
    const pending = readBranchContext(fixture);

    fixture.engine.advance(SCRIPTED_LATENCY_MS);

    await expect(pending).resolves.toStrictEqual({
      status: "served",
      value: SCRIPTED_BRANCH_CONTEXT,
    });
    expect(fixture.engine.pendingReplyCount).toBe(0);
  });

  it("keeps all three codes distinct: the live bridge still refuses as wire-unregistered", async () => {
    // The third code, from the other bridge. A port that answered the same way under
    // both would let a surface ship one rendering for two different facts — nobody
    // asked, versus we asked and the answer never came.
    const outcome =
      await createLiveBridge(createTier1Bridge()).growth.gitflowBranchContextRead(
        BRANCH_CONTEXT_REQUEST,
      );

    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.code).toBe("wire-unregistered");
      expect(outcome.detail).toContain("not registered on this build yet");
    }
  });
});

describe("the fixture bridge's scripted calls — the same seam, rejecting instead", () => {
  it("rejects with the shared code when the engine is torn down under a call", async () => {
    const scenario = scenarioScriptingBranchContext(SCRIPTED_LATENCY_MS);
    const bridge = createFixtureBridge({ scenario });
    const pending = bridge.sidekicks.daemon.call(BRANCH_CONTEXT_CALL as DaemonMethod, undefined);

    engineOf(bridge).dispose();

    // Same engine state, same code, different shape: a `SidekicksBridge` method may
    // only resolve or reject, so the bridge rejects where the port returns an outcome.
    // A code that differed between the two would make the seam two seams.
    await expect(pending).rejects.toBeInstanceOf(FixtureBridgeError);
    await expect(pending).rejects.toMatchObject({
      refusal: { code: "reply-abandoned", origin: "fixture-bridge" },
    });
  });

  it("negative control: the same call resolves once the caller advances the clock", async () => {
    const bridge = createFixtureBridge({ scenario: scenarioScriptingBranchContext() });

    await expect(
      bridge.sidekicks.daemon.call(BRANCH_CONTEXT_CALL as DaemonMethod, undefined),
    ).resolves.toStrictEqual(SCRIPTED_BRANCH_CONTEXT);
  });
});

describe("a computed reply — one call, one answer per entity", () => {
  it("answers each request with the entity that request named", async () => {
    // The defect this arm exists for: `replyFor` matches on the method NAME, so a
    // session holding two mounts asked twice and got the same mount back both times.
    // Both calls go through the real bridge, so what is asserted is what a surface
    // would have received.
    const bridge = createFixtureBridge({ scenario: scenarioComputingMountRead() });

    await expect(
      bridge.sidekicks.daemon.call(MOUNT_READ_CALL, { repoMountId: HEALTHY_MOUNT_ID }),
    ).resolves.toStrictEqual(MOUNT_ANSWERS[HEALTHY_MOUNT_ID]);
    await expect(
      bridge.sidekicks.daemon.call(MOUNT_READ_CALL, { repoMountId: UNREACHABLE_MOUNT_ID }),
    ).resolves.toStrictEqual(MOUNT_ANSWERS[UNREACHABLE_MOUNT_ID]);
  });

  it("refuses a request it scripts no answer for rather than resolving with an absence", async () => {
    // The rule the whole seam is built on: an absent value renders as "there is none",
    // which about a mount the scenario simply does not script is a claim nothing
    // checked. The scenario scripts the METHOD and not this entity, and the fixture's
    // own authoring refusal is what says so.
    const bridge = createFixtureBridge({ scenario: scenarioComputingMountRead() });

    const pending = bridge.sidekicks.daemon.call(MOUNT_READ_CALL, {
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
    const bridge = createFixtureBridge({ scenario: scenarioComputingMountRead() });

    await expect(bridge.sidekicks.daemon.call(MOUNT_READ_CALL, undefined)).rejects.toBeInstanceOf(
      FixtureBridgeError,
    );
  });

  it("negative control: the constant form still answers every request the same way", async () => {
    // Without this, a seam that had made EVERY reply request-sensitive would pass the
    // three cases above while breaking every session-scoped read in the corpus.
    const bridge = createFixtureBridge({ scenario: scenarioConstantMountRead() });

    await expect(
      bridge.sidekicks.daemon.call(MOUNT_READ_CALL, { repoMountId: HEALTHY_MOUNT_ID }),
    ).resolves.toStrictEqual(MOUNT_ANSWERS[HEALTHY_MOUNT_ID]);
    await expect(
      bridge.sidekicks.daemon.call(MOUNT_READ_CALL, { repoMountId: UNSCRIPTED_MOUNT_ID }),
    ).resolves.toStrictEqual(MOUNT_ANSWERS[HEALTHY_MOUNT_ID]);
  });
});
