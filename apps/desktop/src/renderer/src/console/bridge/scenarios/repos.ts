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

export const REPOS_SCENARIO: ConsoleScenario = {
  id: REPOS_SCENARIO_ID,
  label: "Two mounts",
  purpose:
    "A session with a git checkout and a plain-directory mount attached, and a diff over the first. The skeleton lands here; the repos family fills in the mount cards, the worktree rows, and the diff rows.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [PARTICIPANT_YOU, AGENT_IMPLEMENTER],
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
    {
      atMs: 80,
      event: {
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "agent.attached",
        occurredAt: "2026-01-01T09:05:00.080Z",
        // The person who attached the agent, not the agent. The payload is the full
        // persona plus the daemon-resolved state, so the `agents` projection rebuilds
        // from the log alone; `name` is the member — `displayName` is not on this wire.
        actorParticipantId: PARTICIPANT_YOU,
        payload: {
          sessionId: SESSION_ID,
          agentId: AGENT_IMPLEMENTER,
          name: "Implementer",
          driverName: "claude",
          modelId: "claude-sonnet-5",
          state: "ready",
          actor: PARTICIPANT_YOU,
        },
      },
    },
    {
      atMs: 200,
      event: {
        sessionId: SESSION_ID,
        sequence: 3,
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
        sequence: 4,
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
        sequence: 5,
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
        sequence: 6,
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
    {
      atMs: 900,
      event: {
        sessionId: SESSION_ID,
        sequence: 7,
        kind: "diff.created",
        occurredAt: "2026-01-01T09:05:00.900Z",
        actorParticipantId: AGENT_IMPLEMENTER,
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
      // Session-scoped rather than mount-scoped, and both workspaces are
      // `read-only`: a new workspace stays read-only until a run explicitly
      // selects a writable mode.
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
            state: "ready",
            fsRoot: "/Users/dev/notes",
          },
        ],
      },
    },
  ],
};
