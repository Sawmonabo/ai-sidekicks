// Worktree events several contracts tests parse.

import type { WireSessionEvent } from "../../event/__tests__/session.test-support.js";
import type { SessionEvent } from "../../event/variant-types.js";
import type { WorktreeState } from "../lifecycle.js";

// Real RFC 9562 UUIDs (v4 and v7): the schemas validate the version nibble and variant bits, so
// lookalike strings would not parse.
/** The session the worktree events belong to. */
export const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
/** The repository mount the worktree is cut from. */
export const REPO_MOUNT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
/** The workspace the worktree serves. */
export const WORKSPACE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11";
/** The worktree the events describe. */
export const WORKTREE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f12";
/** When the worktree was created. */
export const CREATED_AT = "2026-07-26T09:30:00.000Z";

const USER_ID = "660e8400-e29b-41d4-a716-446655440001";

/**
 * Each worktree event type with the state its emitter writes; `-> failed` has no event. Typing the
 * rows by the event union's `type` makes a dropped variant stop this fixture compiling.
 */
export const REGISTERED_WORKTREE_EVENTS: ReadonlyArray<
  readonly [SessionEvent["type"], WorktreeState]
> = [
  ["worktree.created", "creating"],
  ["worktree.ready", "ready"],
  ["worktree.dirty", "dirty"],
  ["worktree.merged", "merged"],
  ["worktree.retired", "retired"],
];

/** A worktree event of `eventType` whose payload carries `state`. */
export const buildWorktreeEvent = (eventType: string, state: string): WireSessionEvent => ({
  id: "evt-worktree-0001",
  sessionId: SESSION_ID,
  sequence: 11,
  occurredAt: CREATED_AT,
  category: "session_lifecycle",
  type: eventType,
  actor: USER_ID,
  version: "1.0",
  payload: {
    sessionId: SESSION_ID,
    repoMountId: REPO_MOUNT_ID,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    state,
  },
});
