// The repos scenario — a session with work on disk.
//
// What the repos family needs from a fixture is a session that HAS repositories
// attached rather than one that could have: two mounts rather than one, because
// `Spec-009 §Required Behavior` admits several in a session and a section that had
// only ever been drawn against one is a section that has never been drawn as a
// list; and two DIFFERENT mounts, because a plain-directory mount is the case the
// git-only controls have to be unavailable in, and a fixture that only ever serves
// a git checkout cannot reach that state at all.
//
// Beyond the two mounts it states four more facts the family's surfaces are drawn
// against, each of which was previously unreachable: an execution root per agent
// (§10.3's rows), a proposal waiting at the gate with the branch context it is
// bound to (§10.7), a run that was rewound after publishing work (§10.4's rollback
// disclosure), and three attachments whose payloads stand in three different places
// (§10.8's unresolved markers). Every one of them is a beat or a scripted reply, so
// a surface reaches it by advancing the frozen clock and nothing else.
//
// THE IDS ARE UUID-SHAPED, WHICH THIS FILE ORIGINALLY ARGUED THEY NEED NOT BE. The
// premise of that argument was that "no console module parses one" — and the repos
// section now does: it parses every `repo.*` reply with the contract's own schema
// (`packages/contracts/src/repo.ts`), and `RepoMountIdSchema` / `WorkspaceIdSchema` /
// `SessionIdSchema` / `NodeIdSchema` are UUID-formatted. A readable id here would be
// a value the wire cannot carry, which is the one thing a fixture may never script.
// Legibility moves to the NAMES below, which is where a failing assertion reads them;
// what reaches the screen is what the daemon would actually send.
//
// THE HEALTH VERDICTS ARE THE TWO THE CONTRACT SHIPS. `RepoMountHealth.status` in
// `packages/contracts/src/repo.ts` is `healthy | unreachable` today; the third
// verdict the console's repos design renders lands with Plan-009's own phase, and a
// fixture that served it now would be scripting a value no daemon can send.
//
// EVERY BEAT IS A REGISTERED EVENT TYPE, AND EVERY PAYLOAD IS THE SHAPE ITS FAMILY
// DECLARES. The census is `SESSION_EVENT_CATEGORY_BY_TYPE` and the strict layer is
// `SessionEventSchema`, both in `packages/contracts/src/event.ts`; `wire-truth.ts`
// beside this file holds the whole scenario list to them. The eleven
// `repo.*` / `workspace.*` / `worktree.*` beats below carry the registered family
// payload `{sessionId, repoMountId?, workspaceId?, worktreeId?, state, actor?}`, and
// the `run.*` and `artifact_publication` beats carry the shapes
// `Spec-006 §Run Lifecycle (run_lifecycle)` and `Spec-006 §Artifact and Diff Publication (artifact_publication)` state, which
// the strict layer does not yet register a variant for — so the census leg is what
// holds them and the payloads are transcribed from the spec rather than invented.
//
// ONE ANSWER PER CALL, WHICH BOUNDS WHAT THIS FILE CAN STATE. `ScenarioEngine.replyFor`
// matches on the method name alone and ignores the request, so `repo.mountRead` has
// exactly one answer for a session with two mounts. The git mount is the one it
// answers with, because it is the mount both health axes and the reduced-capability
// contrast are read against; the plain mount reaches the section through
// `repo.workspaceList`, which is session-scoped and names both.

import type { ConsoleScenario } from "../scenario.js";

export const REPOS_SCENARIO_ID = "repos";

const SESSION_ID = "9f2c4a10-0000-4000-8000-000000000001";
const NODE_ID = "9f2c4a10-0000-4000-8000-000000000002";
const GIT_MOUNT_ID = "9f2c4a10-0000-4000-8000-000000000003";
const PLAIN_MOUNT_ID = "9f2c4a10-0000-4000-8000-000000000004";
const GIT_WORKSPACE_ID = "9f2c4a10-0000-4000-8000-000000000005";
const PLAIN_WORKSPACE_ID = "9f2c4a10-0000-4000-8000-000000000006";
// The people and agents in the session. Wire-declared UUIDs rather than readable
// placeholders: the wire-truth predicate presents each beat to the strict contract
// layer as the whole envelope it claims to be, and a beat whose actor is not the
// UUID the contract declares is a beat no daemon could emit.
const PARTICIPANT_YOU = "9f2c4a10-0000-4000-8000-000000000010";
const AGENT_IMPLEMENTER = "9f2c4a10-0000-4000-8000-000000000011";
const AGENT_REVIEWER = "9f2c4a10-0000-4000-8000-000000000012";
// One execution root per agent, which is what makes §10.3 a list rather than a row.
const IMPLEMENTER_WORKTREE_ID = "9f2c4a10-0000-4000-8000-000000000020";
const REVIEWER_WORKTREE_ID = "9f2c4a10-0000-4000-8000-000000000021";
const IMPLEMENTER_RUN_ID = "9f2c4a10-0000-4000-8000-000000000030";
const BRANCH_CONTEXT_ID = "9f2c4a10-0000-4000-8000-000000000040";
const DIFF_ARTIFACT_ID = "9f2c4a10-0000-4000-8000-000000000050";
const PINNED_ATTACHMENT_ID = "9f2c4a10-0000-4000-8000-000000000051";
const REPLICATING_ATTACHMENT_ID = "9f2c4a10-0000-4000-8000-000000000052";
const EXPIRED_ATTACHMENT_ID = "9f2c4a10-0000-4000-8000-000000000053";

/**
 * The scenario's viewing participant, and the session it views.
 *
 * Exported because the family's own component fixtures name a producer and a
 * session, and two spellings of one identity is how a fixture and the scenario it
 * is meant to represent come apart — the failure the seats merge fixed in this file
 * and left standing in those. A test reads the constant; nothing at runtime does.
 */
export const REPOS_VIEWING_PARTICIPANT_ID: string = PARTICIPANT_YOU;

/** The session every row in this scenario belongs to. Same reason as above. */
export const REPOS_SESSION_ID: string = SESSION_ID;

/** The run that published the diff and was then rewound. Same reason as above. */
export const REPOS_IMPLEMENTER_RUN_ID: string = IMPLEMENTER_RUN_ID;

/**
 * The two agents, and the execution root each one holds.
 *
 * One table rather than a literal per beat, on the flagship scenario's rule: an
 * `agent.attached` payload and the worktree beats that follow it are views of one
 * record, and two hand-written copies of one agent drift in exactly the direction
 * nothing catches. The drivers are deliberately mixed — a repos fixture whose whole
 * cast runs one provider cannot show what a two-provider session's roots look like.
 */
const REPOS_AGENTS = [
  {
    agentId: AGENT_IMPLEMENTER,
    name: "Implementer",
    driverName: "claude",
    modelId: "claude-sonnet-5",
    worktreeId: IMPLEMENTER_WORKTREE_ID,
    attachedAtMs: 80,
    attachedAtIso: "2026-01-01T09:05:00.080Z",
  },
  {
    agentId: AGENT_REVIEWER,
    name: "Reviewer",
    driverName: "codex",
    modelId: "gpt-5.6-sol",
    worktreeId: REVIEWER_WORKTREE_ID,
    attachedAtMs: 120,
    attachedAtIso: "2026-01-01T09:05:00.120Z",
  },
] as const;

/**
 * The three attachments, and where each one's payload stands on this node.
 *
 * `Spec-014 §Fallback Behavior` requires an unresolved attachment to sit in its
 * declared position carrying its own cause, so the three rows below are three
 * different causes rather than three copies of one — a pinned payload the console
 * can open, one the publisher has not finished replicating, and one whose bytes are
 * no longer obtainable and whose remedy is a re-publish while the publisher is
 * online. `replicationStatus` is the additive member a relay-pinned
 * `artifact.published` carries per `Spec-006 §Artifact and Diff Publication (artifact_publication)`.
 */
const REPOS_ATTACHMENTS = [
  {
    artifactId: PINNED_ATTACHMENT_ID,
    replicationStatus: "pinned",
    atMs: 1360,
    occurredAt: "2026-01-01T09:05:01.360Z",
  },
  {
    artifactId: REPLICATING_ATTACHMENT_ID,
    replicationStatus: "pending_replication",
    atMs: 1400,
    occurredAt: "2026-01-01T09:05:01.400Z",
  },
  {
    artifactId: EXPIRED_ATTACHMENT_ID,
    replicationStatus: "expired",
    atMs: 1440,
    occurredAt: "2026-01-01T09:05:01.440Z",
  },
] as const;

/** The sequence the first `agent.attached` beat takes. One beat precedes it. */
const FIRST_AGENT_SEQUENCE = 2;

/** The sequence the first `worktree.created` beat takes. Seven beats precede it. */
const FIRST_WORKTREE_SEQUENCE = 8;

/** The sequence the first attachment's `artifact.published` beat takes. */
const FIRST_ATTACHMENT_SEQUENCE = 17;

export const REPOS_SCENARIO: ConsoleScenario = {
  id: REPOS_SCENARIO_ID,
  label: "Two mounts",
  purpose:
    "A git checkout and a plain-directory mount, an execution root per agent, a proposal waiting at the gate, a run rewound after it published, and three attachments whose payloads stand in three different places.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [PARTICIPANT_YOU, AGENT_IMPLEMENTER, AGENT_REVIEWER],
  // Which of the three this window is. Stated rather than inferred from the head of
  // the join order — that entry is whoever opened the session, on whichever machine.
  // The fixture's caller-identity read answers from this field and from nothing else.
  viewingParticipantId: PARTICIPANT_YOU,
  startedAtIso: "2026-01-01T09:05:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T09:05:00.000Z",
        actorParticipantId: PARTICIPANT_YOU,
        // The registered shape, verbatim: the new session's id plus the resolved
        // config and metadata, both open records the corpus names no key inside. A
        // title is not on this wire.
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
    ...REPOS_AGENTS.map((agent, agentIndex) => ({
      atMs: agent.attachedAtMs,
      event: {
        sessionId: SESSION_ID,
        sequence: FIRST_AGENT_SEQUENCE + agentIndex,
        kind: "agent.attached",
        occurredAt: agent.attachedAtIso,
        // The person who attached the agent, not the agent. The payload is the full
        // persona plus the daemon-resolved state, so the `agents` projection rebuilds
        // from the log alone; `name` is the member — `displayName` is not on this wire.
        actorParticipantId: PARTICIPANT_YOU,
        payload: {
          sessionId: SESSION_ID,
          agentId: agent.agentId,
          name: agent.name,
          driverName: agent.driverName,
          modelId: agent.modelId,
          state: "ready",
          actor: PARTICIPANT_YOU,
        },
      },
    })),
    {
      atMs: 200,
      event: {
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "repo.attached",
        occurredAt: "2026-01-01T09:05:00.200Z",
        actorParticipantId: PARTICIPANT_YOU,
        payload: { sessionId: SESSION_ID, repoMountId: GIT_MOUNT_ID, state: "attached" },
      },
    },
    {
      // One workspace immediately after a successful attach, which is what
      // `RepoAttachResponse.defaultWorkspaceId` always carries.
      atMs: 260,
      event: {
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "workspace.ready",
        occurredAt: "2026-01-01T09:05:00.260Z",
        actorParticipantId: PARTICIPANT_YOU,
        payload: {
          sessionId: SESSION_ID,
          repoMountId: GIT_MOUNT_ID,
          workspaceId: GIT_WORKSPACE_ID,
          state: "ready",
        },
      },
    },
    {
      atMs: 420,
      event: {
        sessionId: SESSION_ID,
        sequence: 6,
        kind: "repo.attached",
        occurredAt: "2026-01-01T09:05:00.420Z",
        actorParticipantId: PARTICIPANT_YOU,
        payload: { sessionId: SESSION_ID, repoMountId: PLAIN_MOUNT_ID, state: "attached" },
      },
    },
    {
      atMs: 480,
      event: {
        sessionId: SESSION_ID,
        sequence: 7,
        kind: "workspace.ready",
        occurredAt: "2026-01-01T09:05:00.480Z",
        actorParticipantId: PARTICIPANT_YOU,
        payload: {
          sessionId: SESSION_ID,
          repoMountId: PLAIN_MOUNT_ID,
          workspaceId: PLAIN_WORKSPACE_ID,
          state: "ready",
        },
      },
    },
    // A root per agent, in the two-beat `creating -> ready` shape Plan-010 D-010-12
    // emits. Both hang off the GIT mount's workspace: a worktree is a git-backed
    // execution root, so a plain-directory mount has none and never grows one.
    ...REPOS_AGENTS.flatMap((agent, agentIndex) => [
      {
        atMs: 620 + agentIndex * 140,
        event: {
          sessionId: SESSION_ID,
          sequence: FIRST_WORKTREE_SEQUENCE + agentIndex * 2,
          kind: "worktree.created",
          occurredAt: agentIndex === 0 ? "2026-01-01T09:05:00.620Z" : "2026-01-01T09:05:00.760Z",
          actorParticipantId: PARTICIPANT_YOU,
          payload: {
            sessionId: SESSION_ID,
            repoMountId: GIT_MOUNT_ID,
            workspaceId: GIT_WORKSPACE_ID,
            worktreeId: agent.worktreeId,
            state: "creating",
          },
        },
      },
      {
        atMs: 700 + agentIndex * 140,
        event: {
          sessionId: SESSION_ID,
          sequence: FIRST_WORKTREE_SEQUENCE + agentIndex * 2 + 1,
          kind: "worktree.ready",
          occurredAt: agentIndex === 0 ? "2026-01-01T09:05:00.700Z" : "2026-01-01T09:05:00.840Z",
          actorParticipantId: PARTICIPANT_YOU,
          payload: {
            sessionId: SESSION_ID,
            repoMountId: GIT_MOUNT_ID,
            workspaceId: GIT_WORKSPACE_ID,
            worktreeId: agent.worktreeId,
            state: "ready",
          },
        },
      },
    ]),
    {
      atMs: 900,
      event: {
        sessionId: SESSION_ID,
        sequence: 12,
        kind: "run.queued",
        occurredAt: "2026-01-01T09:05:00.900Z",
        actorParticipantId: PARTICIPANT_YOU,
        // A run-lifecycle payload is a STATE TRANSITION carrying the progression
        // counter, not a bare id. `previousState` is absent here and only here: a
        // queued run is being born, and no document names a value for the state it
        // came from — so none is invented.
        payload: {
          sessionId: SESSION_ID,
          runId: IMPLEMENTER_RUN_ID,
          runVersion: 1,
          newState: "queued",
          agentId: AGENT_IMPLEMENTER,
        },
      },
    },
    {
      atMs: 960,
      event: {
        sessionId: SESSION_ID,
        sequence: 13,
        kind: "run.starting",
        occurredAt: "2026-01-01T09:05:00.960Z",
        // No actor. The daemon moves a run from `queued` to `starting`; a
        // participant id here would attribute a system transition to a person.
        payload: {
          sessionId: SESSION_ID,
          runId: IMPLEMENTER_RUN_ID,
          runVersion: 2,
          previousState: "queued",
          newState: "starting",
        },
      },
    },
    {
      atMs: 1020,
      event: {
        sessionId: SESSION_ID,
        sequence: 14,
        kind: "run.running",
        occurredAt: "2026-01-01T09:05:01.020Z",
        // `executionPosture` is stamped on this transition and only this one — the
        // post-setup-gate spawn success, where the resolved workspace root and the
        // effective posture are final (`Spec-006 §Run Lifecycle (run_lifecycle)`). The shape is the
        // registered `ExecutionPosture` in `packages/contracts/src/provider-driver.ts`,
        // whose sandboxed arms REQUIRE `credentialPolicyRef` — a content-addressed
        // reference rather than a credential list, so the posture reveals which
        // credentials were denied without revealing the installation.
        payload: {
          sessionId: SESSION_ID,
          runId: IMPLEMENTER_RUN_ID,
          runVersion: 3,
          previousState: "starting",
          newState: "running",
          executionPosture: {
            mode: "workspace-sandboxed",
            credentialPolicyRef:
              "sha256:0d1a5c6f9e2b4708c31d5a9f6e2b47083c1d5a9f6e2b47083c1d5a9f6e2b4708",
            networkAccess: "none",
            writableRoots: ["/Users/dev/code/ai-sidekicks-worktrees/rate-limit-wiring"],
          },
        },
      },
    },
    {
      // Uncommitted work in the implementer's root. The state the reclaim controls
      // have to be unavailable in, and the reason the proposal below is worth
      // reviewing rather than assumed clean.
      atMs: 1200,
      event: {
        sessionId: SESSION_ID,
        sequence: 15,
        kind: "worktree.dirty",
        occurredAt: "2026-01-01T09:05:01.200Z",
        payload: {
          sessionId: SESSION_ID,
          repoMountId: GIT_MOUNT_ID,
          workspaceId: GIT_WORKSPACE_ID,
          worktreeId: IMPLEMENTER_WORKTREE_ID,
          state: "dirty",
        },
      },
    },
    {
      atMs: 1300,
      event: {
        sessionId: SESSION_ID,
        sequence: 16,
        kind: "diff.created",
        occurredAt: "2026-01-01T09:05:01.300Z",
        actorParticipantId: AGENT_IMPLEMENTER,
        // `Spec-006 §Artifact and Diff Publication (artifact_publication)`'s family payload, verbatim:
        // `{sessionId, artifactId?, runId?, diffArtifactId?, visibility?, state}`. A
        // diff names itself through `diffArtifactId`; the base and head refs a diff
        // header renders are the branch context's and reach the console through
        // `gitflow.branchContextRead`, never through this beat.
        payload: {
          sessionId: SESSION_ID,
          diffArtifactId: DIFF_ARTIFACT_ID,
          runId: IMPLEMENTER_RUN_ID,
          visibility: "local-only",
          state: "published",
        },
      },
    },
    ...REPOS_ATTACHMENTS.map((attachment, attachmentIndex) => ({
      atMs: attachment.atMs,
      event: {
        sessionId: SESSION_ID,
        sequence: FIRST_ATTACHMENT_SEQUENCE + attachmentIndex,
        kind: "artifact.published",
        occurredAt: attachment.occurredAt,
        actorParticipantId: PARTICIPANT_YOU,
        payload: {
          sessionId: SESSION_ID,
          artifactId: attachment.artifactId,
          runId: IMPLEMENTER_RUN_ID,
          visibility: "shared",
          state: "published",
          replicationStatus: attachment.replicationStatus,
        },
      },
    })),
    {
      // The proposal reaches the gate. `pr.prepared` is the census member for a
      // proposal assembled from a diff artifact and NOT yet sent anywhere —
      // `pr.submitted` is the remote mutation, and this scenario deliberately stops
      // short of it so the gate is drawn in the state it exists to be reviewed in.
      atMs: 1600,
      event: {
        sessionId: SESSION_ID,
        sequence: 20,
        kind: "pr.prepared",
        occurredAt: "2026-01-01T09:05:01.600Z",
        actorParticipantId: AGENT_IMPLEMENTER,
        payload: {
          sessionId: SESSION_ID,
          diffArtifactId: DIFF_ARTIFACT_ID,
          runId: IMPLEMENTER_RUN_ID,
          visibility: "local-only",
          state: "prepared",
        },
      },
    },
    {
      // The rewind. A FORWARD, non-terminal event with its own payload — no
      // `previousState` / `newState`, because a rollback is not a state transition
      // (`Spec-006 §Run Lifecycle (run_lifecycle)`), and `targetPosition` is the turn-boundary anchor
      // the run actually landed at. The turns above it stay in the log and are marked
      // superseded by projection; nothing is truncated.
      atMs: 1800,
      event: {
        sessionId: SESSION_ID,
        sequence: 21,
        kind: "run.rolled_back",
        occurredAt: "2026-01-01T09:05:01.800Z",
        actorParticipantId: PARTICIPANT_YOU,
        payload: {
          sessionId: SESSION_ID,
          runId: IMPLEMENTER_RUN_ID,
          runVersion: 4,
          targetPosition: 2,
        },
      },
    },
    {
      // The plain mount's workspace loses its path. §10.1's third refresh trigger —
      // the section re-reads on this frame and on nothing timed — and the scripted
      // `repo.workspaceList` below reports the same `stale` state, so the frame and
      // the read agree rather than telling a surface two different stories.
      atMs: 1900,
      event: {
        sessionId: SESSION_ID,
        sequence: 22,
        kind: "workspace.stale",
        occurredAt: "2026-01-01T09:05:01.900Z",
        payload: {
          sessionId: SESSION_ID,
          repoMountId: PLAIN_MOUNT_ID,
          workspaceId: PLAIN_WORKSPACE_ID,
          state: "stale",
        },
      },
    },
  ],
  replies: [
    {
      // `Spec-009`'s only health-carrying read. `localPath` and `canonicalRoot`
      // differ here on purpose: the mount was entered from a nested subdirectory,
      // which is the case that separates provenance from resolved identity and the
      // reason the card surfaces both.
      call: "repo.mountRead",
      result: {
        id: GIT_MOUNT_ID,
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        localPath: "/Users/dev/code/ai-sidekicks/packages/contracts",
        canonicalRoot: "/Users/dev/code/ai-sidekicks",
        vcsType: "git",
        state: "attached",
        health: { status: "healthy", checkedAt: "2026-01-01T09:05:01.000Z" },
        attachedAt: "2026-01-01T09:05:00.200Z",
      },
    },
    {
      // The WORKSPACE-scoped arm of `repo.executionModeCapabilitiesRead` — the
      // post-bind question the mode picker asks. The answer is the git mount's,
      // matching the mount `repo.mountRead` above returns: all four modes, with
      // `worktree` the default for the next writable coding run per ADR-006, and no
      // `restrictions` map at all, because a git mount restricts nothing (D-009-5).
      // `defaultMode` is deliberately NOT the workspace's current mode: the rows
      // below are all bound `read-only`, which is what a new workspace stays until a
      // run explicitly selects otherwise, and the picker labels the two separately.
      call: "repo.executionModeCapabilitiesRead",
      result: {
        availableModes: ["read-only", "branch", "worktree", "ephemeral clone"],
        defaultMode: "worktree",
      },
    },
    {
      // What an explicit switch answers with. `provisioning` rather than `ready`,
      // and no `executionRoot`: a writable select returns while the workspace is
      // still provisioning and the root does not exist yet, and a placeholder root
      // would be a guess the contract admits no fallback for (I-010-7).
      call: "repo.executionModeSelect",
      result: {
        workspaceId: GIT_WORKSPACE_ID,
        executionMode: "worktree",
        state: "provisioning",
      },
    },
    {
      // Session-scoped rather than mount-scoped. The git workspace is `read-only`,
      // which is what a new workspace stays until a run explicitly selects a writable
      // mode; the plain one is `stale`, agreeing with the beat above it, and carries
      // the daemon's own sentence about why rather than an empty row.
      call: "repo.workspaceList",
      result: {
        workspaces: [
          {
            id: GIT_WORKSPACE_ID,
            repoMountId: GIT_MOUNT_ID,
            executionMode: "read-only",
            state: "ready",
            fsRoot: "/Users/dev/code/ai-sidekicks",
          },
          {
            id: PLAIN_WORKSPACE_ID,
            repoMountId: PLAIN_MOUNT_ID,
            executionMode: "read-only",
            state: "stale",
            fsRoot: "/Users/dev/notes",
            lastError: "The bound path is no longer reachable on this node.",
          },
        ],
      },
    },
    {
      // The first growth read this fixture answers from a SCRIPT rather than from a
      // derivation. `createFixtureGrowthPort` routes `gitflowBranchContextRead`
      // through `answerFromScriptedReply`, so the reply below is served verbatim on
      // the frozen clock, and the two non-arrival refusals a real read has stay
      // reachable. Until this entry existed the port answered every scenario with the
      // absence, and the proposal gate could only ever be drawn against a session
      // with no branch context at all.
      //
      // The four values are `Spec-011 §Interfaces And Contracts`'s and are wire
      // strings the console never computes: nothing here derives a branch name from a
      // pane, a tab, or a focused view. `worktreeId` is the anchoring this context
      // actually has — `branch_contexts` carries an at-most-one association check, so
      // naming `ephemeralCloneId` beside it would be a shape no producer can emit.
      call: "gitflow.branchContextRead",
      result: {
        branchContext: {
          branchContextId: BRANCH_CONTEXT_ID,
          workspaceId: GIT_WORKSPACE_ID,
          baseBranch: "develop",
          headBranch: "feat/rate-limit-wiring",
          upstreamRef: "origin/feat/rate-limit-wiring",
          worktreeId: IMPLEMENTER_WORKTREE_ID,
        },
      },
    },
  ],
};
