// What the repos scenario states, and that a surface can actually reach it.
//
// The claims worth asserting here are the ones a reader of the file cannot check by
// reading it: that every beat is a type the wire registers and a payload its family
// declares (the predicate beside it answers that, and the negative controls below
// prove the predicate is looking), that the branch context the file scripts is
// SERVED rather than scripted into a port that ignores it, and that the four facts
// the repos family is drawn against — two mounts, a root per agent, a proposal
// waiting at the gate, three payloads standing in three different places — are each
// reachable from the scenario rather than from a component fixture.

import { describe, expect, it } from "vitest";

import type { DaemonMethod } from "@ai-sidekicks/contracts";

import { createFixtureBridge } from "../fixture/fixture-bridge.js";
import {
  REPOS_IMPLEMENTER_RUN_ID,
  REPOS_SCENARIO,
  REPOS_SESSION_ID,
  REPOS_VIEWING_PARTICIPANT_ID,
} from "./repos.js";
import { REPOS_SCENARIO_STARTED_AT_ISO, scenarioInstant } from "./repos-beats.js";
import {
  GIT_MOUNT_ID,
  GIT_WORKSPACE_ID,
  IMPLEMENTER_WORKTREE_ID,
  PLAIN_MOUNT_ID,
  PLAIN_WORKSPACE_ID,
  REVIEWER_WORKTREE_ID,
} from "./repos-fixture-data.js";
import { findScenarioWireTruthDefects } from "./wire-truth.js";
import type { ConsoleScenario } from "../scenario-runtime/scenario.js";

/** Every beat of one kind, in scenario order. */
function beatsOfKind(kind: string): readonly ConsoleScenario["beats"][number]["event"][] {
  return REPOS_SCENARIO.beats.filter((beat) => beat.event.kind === kind).map((beat) => beat.event);
}

/** One payload member, read as the wire would read it. */
function payloadMember(event: ConsoleScenario["beats"][number]["event"], member: string): unknown {
  return event.payload?.[member];
}

describe("the repos scenario — every beat is a wire the daemon can emit", () => {
  it("writes its base instant the same way twice", () => {
    // The base is spelled as an ISO string for the wire and as parts for the
    // arithmetic, and every beat's stamp is derived from the second. Reading either
    // through a parser to check the other would put the console's own stamp reader
    // under a fixture that exists to drive it, so the two are compared where they
    // meet: the stamp the beat builder renders at offset zero.
    expect(scenarioInstant(0)).toBe(REPOS_SCENARIO_STARTED_AT_ISO);
  });

  it("contradicts the shipped contract nowhere", () => {
    expect(findScenarioWireTruthDefects([REPOS_SCENARIO])).toStrictEqual([]);
  });

  it("negative control: an invented event type is reported", () => {
    const withInventedKind: ConsoleScenario = {
      ...REPOS_SCENARIO,
      id: "repos-invented-kind",
      beats: [
        {
          atMs: 0,
          event: {
            id: "9f2c4a10-0000-4000-8000-000100000001",
            sessionId: REPOS_SESSION_ID,
            sequence: 1,
            // `repo.mounted` reads exactly like the real thing and is not in the
            // census — `repo.attached` is.
            kind: "repo.mounted",
            occurredAt: "2026-01-01T09:05:00.000Z",
            payload: { sessionId: REPOS_SESSION_ID, state: "attached" },
          },
        },
      ],
    };

    expect(findScenarioWireTruthDefects([withInventedKind])).not.toStrictEqual([]);
  });

  it("negative control: a registered type carrying a member its family rejects is reported", () => {
    const withInventedMember: ConsoleScenario = {
      ...REPOS_SCENARIO,
      id: "repos-invented-member",
      beats: [
        {
          atMs: 0,
          event: {
            id: "9f2c4a10-0000-4000-8000-000100000001",
            sessionId: REPOS_SESSION_ID,
            sequence: 1,
            kind: "repo.attached",
            occurredAt: "2026-01-01T09:05:00.000Z",
            // The family payload is `{sessionId, repoMountId?, workspaceId?,
            // worktreeId?, state, actor?}` and it is strict, so a `canonicalRoot`
            // here is rejected outright — the path reaches a card through
            // `repo.mountRead`, never through the event.
            payload: {
              sessionId: REPOS_SESSION_ID,
              state: "attached",
              canonicalRoot: "/Users/dev/code/ai-sidekicks",
            },
          },
        },
      ],
    };

    expect(findScenarioWireTruthDefects([withInventedMember])).not.toStrictEqual([]);
  });
});

describe("the repos scenario — the facts the repos family is drawn against", () => {
  it("attaches two mounts, so the section is a list even before it has to be", () => {
    const attached = beatsOfKind("repo.attached");
    const mountIds = new Set(attached.map((event) => payloadMember(event, "repoMountId")));

    expect(attached).toHaveLength(2);
    expect(mountIds.size).toBe(2);
  });

  it("gives every agent its own execution root, and hangs none off a plain directory", () => {
    const agentIds = new Set(
      beatsOfKind("agent.attached").map((event) => payloadMember(event, "agentId")),
    );
    const readyRoots = beatsOfKind("worktree.ready");
    const rootIds = new Set(readyRoots.map((event) => payloadMember(event, "worktreeId")));
    const rootWorkspaces = new Set(readyRoots.map((event) => payloadMember(event, "workspaceId")));

    expect(rootIds.size).toBe(agentIds.size);
    // A worktree is a git-backed execution root, so every one of them belongs to the
    // one workspace whose mount is a git checkout. A second workspace here would be
    // a root on a plain directory, which no daemon can provision.
    expect(rootWorkspaces.size).toBe(1);
  });

  it("puts a proposal at the gate without sending it anywhere", () => {
    expect(beatsOfKind("pr.prepared")).toHaveLength(1);
    // The remote mutation is a different event, and this scenario deliberately never
    // reaches it — the gate exists to be reviewed before anything leaves the machine.
    expect(beatsOfKind("pr.submitted")).toHaveLength(0);
  });

  it("rewinds the run that published, and keeps the published rows in the log", () => {
    const rolledBack = beatsOfKind("run.rolled_back");
    const [rollback] = rolledBack;

    expect(rolledBack).toHaveLength(1);
    expect(payloadMember(rollback!, "runId")).toBe(REPOS_IMPLEMENTER_RUN_ID);
    // The anchor the run landed at, not a count of what was removed: the log never
    // truncates, so the diff published above the anchor is still a beat.
    expect(payloadMember(rollback!, "targetPosition")).toStrictEqual(expect.any(Number));
    expect(beatsOfKind("diff.created")).toHaveLength(1);
  });

  it("stands three attachment payloads in three different places", () => {
    const published = beatsOfKind("artifact.published");
    const statuses = published.map((event) => payloadMember(event, "replicationStatus"));

    expect(published).toHaveLength(3);
    expect(new Set(statuses).size).toBe(3);
    // One of them is obtainable and two are not, which is what makes the unresolved
    // marker and the resolved chip both reachable from one scenario.
    expect(statuses).toContain("pinned");
  });

  it("names a viewer the session actually joined", () => {
    expect(REPOS_SCENARIO.participantIdsInJoinOrder).toContain(REPOS_VIEWING_PARTICIPANT_ID);
  });
});

describe("the repos scenario — the growth reads it answers", () => {
  it("answers each execution root with its own branch context", async () => {
    // The read is keyed by the `(workspaceId, worktreeId)` PAIR, and this session holds
    // two roots in one workspace. A method-only reply handed both gates one answer, so
    // the reviewer's gate showed the implementer's context id and head branch and the
    // scenario's screenshots passed over a gate that had never been bound per root.
    const bridge = createFixtureBridge({ scenario: REPOS_SCENARIO });

    const implementer = await bridge.growth.gitflowBranchContextRead({
      workspaceId: GIT_WORKSPACE_ID,
      worktreeId: IMPLEMENTER_WORKTREE_ID,
    });
    const reviewer = await bridge.growth.gitflowBranchContextRead({
      workspaceId: GIT_WORKSPACE_ID,
      worktreeId: REVIEWER_WORKTREE_ID,
    });

    expect(implementer.status).toBe("served");
    expect(reviewer.status).toBe("served");
    if (implementer.status !== "served" || reviewer.status !== "served") {
      throw new Error("the fixture refused a branch-context read this scenario scripts");
    }
    // The values `Spec-011 §Interfaces And Contracts` requires, read straight off the
    // reply — the registered response is flat.
    expect(implementer.value.baseBranch).toBe("develop");
    expect(implementer.value.headBranch).toBe("feat/rate-limit-wiring");
    expect(implementer.value.worktreeId).toBe(IMPLEMENTER_WORKTREE_ID);
    expect(reviewer.value.headBranch).toBe("review/rate-limit-wiring");
    expect(reviewer.value.worktreeId).toBe(REVIEWER_WORKTREE_ID);
    expect(reviewer.value.branchContextId).not.toBe(implementer.value.branchContextId);
  });

  it("names each root's head branch the same way its status row does", () => {
    // The gate drawn under a root and the root itself are one piece of work, so two
    // spellings of one branch is how a fixture stops representing a session.
    const roots = REPOS_SCENARIO.replies.find((reply) => reply.call === "repo.worktreeStatusRead");
    const scripted = (roots as { readonly result: { readonly worktrees: readonly unknown[] } })
      .result.worktrees as readonly { readonly worktreeId: string; readonly branchName: string }[];
    expect(scripted.find((root) => root.worktreeId === REVIEWER_WORKTREE_ID)?.branchName).toBe(
      "review/rate-limit-wiring",
    );
  });

  it("negative control: a root this scenario does not hold is refused, not answered", async () => {
    // Without this the case above would pass against a fixture that answered whatever
    // it had for any request — which is the defect it exists to catch, one step removed.
    const bridge = createFixtureBridge({ scenario: REPOS_SCENARIO });

    const unheld = await bridge.growth.gitflowBranchContextRead({
      workspaceId: GIT_WORKSPACE_ID,
      worktreeId: "unread-by-the-fixture",
    });

    expect(unheld.status).toBe("unavailable");
    expect(unheld).not.toHaveProperty("value");
  });

  it("answers the caller-identity read with the viewer it states", async () => {
    const bridge = createFixtureBridge({ scenario: REPOS_SCENARIO });

    const outcome = await bridge.growth.callerParticipantRead({ sessionId: REPOS_SESSION_ID });

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value.participantId).toBe(REPOS_VIEWING_PARTICIPANT_ID);
    }
  });

  it("negative control: a scenario stating no viewer refuses that read", async () => {
    const { viewingParticipantId: _stated, ...withoutViewer } = REPOS_SCENARIO;
    const bridge = createFixtureBridge({ scenario: { ...withoutViewer, id: "repos-no-viewer" } });

    const outcome = await bridge.growth.callerParticipantRead({ sessionId: REPOS_SESSION_ID });

    expect(outcome.status).toBe("unavailable");
  });
});

/** The two entity-scoped reads, branded once — the spelling `repo-reads.ts` sends. */
const MOUNT_READ_CALL = "repo.mountRead" as DaemonMethod;
const CAPABILITIES_READ_CALL = "repo.executionModeCapabilitiesRead" as DaemonMethod;

describe("the repos scenario — the two entity-scoped reads answer per entity", () => {
  it("answers each mount read with the mount that read named", async () => {
    // The two mounts the section is a LIST for. Until the reply was computed from the
    // request, both reads returned the git mount, so the plain-directory mount never
    // reached a card and the degraded health verdict — which only this read carries —
    // was unreachable from any scenario at all.
    const bridge = createFixtureBridge({ scenario: REPOS_SCENARIO });

    const git = await bridge.sidekicks.daemon.call(MOUNT_READ_CALL, {
      repoMountId: GIT_MOUNT_ID,
    });
    const plain = await bridge.sidekicks.daemon.call(MOUNT_READ_CALL, {
      repoMountId: PLAIN_MOUNT_ID,
    });

    expect(git).toMatchObject({ id: GIT_MOUNT_ID, vcsType: "git" });
    expect(plain).toMatchObject({ id: PLAIN_MOUNT_ID, vcsType: "none" });
    // The two health verdicts the contract ships, one each, so the healthy card and
    // the degraded card are both drawn from this one session.
    expect(git).toMatchObject({ health: { status: "healthy" } });
    expect(plain).toMatchObject({ health: { status: "unreachable" } });
  });

  it("answers each capabilities read with what that workspace may actually do", async () => {
    // The half a mount read alone would leave incoherent: a `none` mount offered all
    // four execution modes is a picker drawn against a mount that can host one.
    const bridge = createFixtureBridge({ scenario: REPOS_SCENARIO });

    const gitModes = await bridge.sidekicks.daemon.call(CAPABILITIES_READ_CALL, {
      workspaceId: GIT_WORKSPACE_ID,
    });
    const plainModes = await bridge.sidekicks.daemon.call(CAPABILITIES_READ_CALL, {
      workspaceId: PLAIN_WORKSPACE_ID,
    });

    expect(gitModes).toMatchObject({
      availableModes: ["read-only", "branch", "worktree", "ephemeral clone"],
      defaultMode: "worktree",
    });
    expect(plainModes).toMatchObject({
      availableModes: ["read-only"],
      defaultMode: "read-only",
    });
    // Every excluded mode carries its own reason, which is the explicit gap a surface
    // renders instead of a control it silently does not offer.
    const { restrictions } = plainModes as {
      readonly restrictions?: Readonly<Record<string, string>>;
    };
    expect(Object.keys(restrictions ?? {}).sort()).toStrictEqual([
      "branch",
      "ephemeral clone",
      "worktree",
    ]);
  });

  it("negative control: a mount this session does not hold is refused, not answered", async () => {
    // Without this, a computation that ignored the request and returned the git mount
    // for everything would pass the first case above.
    const bridge = createFixtureBridge({ scenario: REPOS_SCENARIO });

    await expect(
      bridge.sidekicks.daemon.call(MOUNT_READ_CALL, {
        repoMountId: "9f2c4a10-0000-4000-8000-0000000000ff",
      }),
    ).rejects.toThrow();
  });
});
