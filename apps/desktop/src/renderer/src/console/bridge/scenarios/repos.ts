// The repos scenario — skeleton.
//
// What the repos family needs from a fixture is a session that has repositories
// attached rather than one that could have: two mounts rather than one, because
// `Spec-009 §Required Behavior` admits several in a session and a section that had
// only ever been drawn against one is a section that has never been drawn as a
// list; and two DIFFERENT mounts, because a plain-directory mount is the case the
// git-only controls have to be unavailable in, and a fixture that only ever serves
// a git checkout cannot reach that state at all.
//
// The mount cards, the worktree rows, and the diff rows are built beside this file
// in the repos family, and they fill this scenario out as they land. What is here
// is the shape they are built against: the beats that put mounts on screen and the
// two reads that answer for them.
//
// THE IDS ARE READABLE RATHER THAN UUID-SHAPED, which is `flagship.ts`'s convention
// and is safe for the same reason: the wire mints these ids as server-side UUIDs
// and no console module parses one. A renderer that treated an id as anything but
// an opaque string would be broken against the real wire whatever the fixture said,
// and a readable id makes a failing assertion name the mount it is about.
//
// THE HEALTH VERDICTS ARE THE TWO THE CONTRACT SHIPS. `RepoMountHealth.status` in
// `packages/contracts/src/repo.ts` is `healthy | unreachable` today; the third
// verdict the console's repos design renders lands with Plan-009's own phase, and a
// fixture that served it now would be scripting a value no daemon can send.

import type { ConsoleScenario } from "../scenario.js";

export const REPOS_SCENARIO_ID = "repos";

const SESSION_ID = "session-repos";
const NODE_ID = "node-workstation";
const GIT_MOUNT_ID = "mount-sidekicks";
const PLAIN_MOUNT_ID = "mount-notes";

export const REPOS_SCENARIO: ConsoleScenario = {
  id: REPOS_SCENARIO_ID,
  label: "Two mounts",
  purpose:
    "A session with a git checkout and a plain-directory mount attached, and a diff over the first. The skeleton lands here; the repos family fills in the mount cards, the worktree rows, and the diff rows.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: ["participant-you", "agent-implementer"],
  startedAtIso: "2026-01-01T09:05:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T09:05:00.000Z",
        actorParticipantId: "participant-you",
        payload: { title: "Repo mounts and diffs" },
      },
    },
    {
      atMs: 80,
      event: {
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "agent.attached",
        occurredAt: "2026-01-01T09:05:00.080Z",
        actorParticipantId: "agent-implementer",
        payload: { agentId: "agent-implementer", displayName: "Implementer" },
      },
    },
    {
      atMs: 200,
      event: {
        sessionId: SESSION_ID,
        sequence: 3,
        kind: "repo.attached",
        occurredAt: "2026-01-01T09:05:00.200Z",
        actorParticipantId: "participant-you",
        payload: { sessionId: SESSION_ID, repoMountId: GIT_MOUNT_ID, state: "attached" },
      },
    },
    {
      // One workspace immediately after a successful attach, which is what
      // `RepoAttachResponse.defaultWorkspaceId` always carries.
      atMs: 260,
      event: {
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "workspace.ready",
        occurredAt: "2026-01-01T09:05:00.260Z",
        actorParticipantId: "participant-you",
        payload: {
          sessionId: SESSION_ID,
          repoMountId: GIT_MOUNT_ID,
          workspaceId: "workspace-sidekicks",
          state: "ready",
        },
      },
    },
    {
      atMs: 420,
      event: {
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "repo.attached",
        occurredAt: "2026-01-01T09:05:00.420Z",
        actorParticipantId: "participant-you",
        payload: { sessionId: SESSION_ID, repoMountId: PLAIN_MOUNT_ID, state: "attached" },
      },
    },
    {
      atMs: 480,
      event: {
        sessionId: SESSION_ID,
        sequence: 6,
        kind: "workspace.ready",
        occurredAt: "2026-01-01T09:05:00.480Z",
        actorParticipantId: "participant-you",
        payload: {
          sessionId: SESSION_ID,
          repoMountId: PLAIN_MOUNT_ID,
          workspaceId: "workspace-notes",
          state: "ready",
        },
      },
    },
    {
      atMs: 900,
      event: {
        sessionId: SESSION_ID,
        sequence: 7,
        kind: "diff.created",
        occurredAt: "2026-01-01T09:05:00.900Z",
        actorParticipantId: "agent-implementer",
        payload: {
          artifactId: "artifact-diff-01",
          // The attribution axis is a first-class field and never inferred. This
          // beat is the run-attributed arm; the workspace-fallback arm is the one
          // the diff header has to render differently, and it lands with the rows.
          attribution: "run_attributed",
          runId: "run-01",
          baseRef: "main",
          headRef: "feat/rate-limit-wiring",
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
      // Session-scoped rather than mount-scoped, and both workspaces are
      // `read-only`: a new workspace stays read-only until a run explicitly
      // selects a writable mode.
      call: "repo.workspaceList",
      result: {
        workspaces: [
          {
            id: "workspace-sidekicks",
            repoMountId: GIT_MOUNT_ID,
            executionMode: "read-only",
            state: "ready",
            fsRoot: "/Users/dev/code/ai-sidekicks",
          },
          {
            id: "workspace-notes",
            repoMountId: PLAIN_MOUNT_ID,
            executionMode: "read-only",
            state: "ready",
            fsRoot: "/Users/dev/notes",
          },
        ],
      },
    },
  ],
};
