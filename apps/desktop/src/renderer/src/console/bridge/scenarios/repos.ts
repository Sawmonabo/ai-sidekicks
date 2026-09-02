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
// THE CAST LIVES BESIDE THIS FILE. `repos-fixture-data.ts` holds the identifiers,
// the two agents, and the three attachments; `repos-replies.ts` holds the answers a
// call gets. This file is the beats and the scenario record that carries them — the
// three-way split `workflow-fixture-data.ts` set the precedent for, taken when this
// file passed the size the structure rules set.

import type { ConsoleScenario } from "../scenario.js";

import {
  AGENT_IMPLEMENTER,
  AGENT_REVIEWER,
  DIFF_ARTIFACT_ID,
  FIRST_AGENT_SEQUENCE,
  FIRST_ATTACHMENT_SEQUENCE,
  FIRST_WORKTREE_SEQUENCE,
  GIT_MOUNT_ID,
  GIT_WORKSPACE_ID,
  IMPLEMENTER_RUN_ID,
  IMPLEMENTER_WORKTREE_ID,
  PARTICIPANT_YOU,
  PLAIN_MOUNT_ID,
  PLAIN_WORKSPACE_ID,
  REPOS_AGENTS,
  REPOS_ATTACHMENTS,
  SESSION_ID,
} from "./repos-fixture-data.js";
import { REPOS_SCENARIO_REPLIES } from "./repos-replies.js";

export const REPOS_SCENARIO_ID = "repos";

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
  replies: REPOS_SCENARIO_REPLIES,
};
