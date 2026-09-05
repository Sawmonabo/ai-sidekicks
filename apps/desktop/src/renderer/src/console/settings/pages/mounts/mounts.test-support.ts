// The cast both mounts suites drive the page and its inventory with.
//
// Hoisted on second use, per `apps/desktop/AGENTS.md`. The two files ask different
// questions — one about the composed read and its cap, the other about what the page
// draws — but they name the same session, the same node, and the same two mounts,
// and they built the same four id generators and the same store opener twice, 350
// lines apart in files whose readers are not looking at each other. `SessionStore`
// gaining one required field on `initialise` moved two bodies; it now moves one.
//
// THE IDS ARE UUIDS rather than readable strings, because the call door parses the
// REQUEST against the registered schema before it sends: `sessionId`, `repoMountId`,
// and a workspace id are branded UUID scalars, so a readable `mount-007` is refused
// as `request-unsendable` and the daemon is never asked at all — every case in the
// cap block would fail on the request rather than exercise the cap. Named, so the
// cases still read as "the first mount" rather than as a hex string.

import type { RepoMountReadResponse, WorkspaceListResponse } from "@ai-sidekicks/contracts";

import { SessionStore, type ConsoleSessionEvent } from "../../../store/index.js";

/** The session both suites read for. */
export const SESSION_ID = "019b7911-0000-7000-8000-000000000001";

/** The node every mount below is attached on. */
export const NODE_ID = "019b7911-0003-7000-8000-000000000001";

/** The first mount, named so a case reads as a mount rather than as a hex string. */
export const MOUNT_A = "019b7911-0001-7000-8000-00000000000a";

/** The second mount, for the cases that need two. */
export const MOUNT_B = "019b7911-0001-7000-8000-00000000000b";

/** One workspace id, derived from its position so a list of any length is on-contract. */
export function workspaceIdAt(index: number): WorkspaceListResponse["workspaces"][number]["id"] {
  const suffix = String(index).padStart(12, "0");
  return `019b7911-0002-7000-8000-${suffix}` as WorkspaceListResponse["workspaces"][number]["id"];
}

/** One mount id, derived from its position so a list of any length is on-contract. */
export function mountIdAt(index: number): string {
  return `019b7911-0004-7000-8000-${String(index).padStart(12, "0")}`;
}

/** A workspace list naming each of `mountIds`, in order. */
export function workspaceListWith(mountIds: readonly string[]): WorkspaceListResponse {
  return {
    workspaces: mountIds.map((repoMountId, index) => ({
      id: workspaceIdAt(index),
      repoMountId: repoMountId as WorkspaceListResponse["workspaces"][number]["repoMountId"],
      executionMode: "worktree",
      state: "ready",
    })),
  };
}

/**
 * One healthy attached mount, with the overrides a case needs to make it otherwise.
 *
 * The overrides land last so a case that has to say "this axis disagrees with that
 * one" writes only the axis it moved.
 */
export function mountReadFor(
  repoMountId: string,
  overrides: Partial<RepoMountReadResponse> = {},
): RepoMountReadResponse {
  return {
    id: repoMountId as RepoMountReadResponse["id"],
    sessionId: SESSION_ID as RepoMountReadResponse["sessionId"],
    nodeId: NODE_ID as RepoMountReadResponse["nodeId"],
    localPath: `/repos/${repoMountId}`,
    canonicalRoot: `/repos/${repoMountId}`,
    vcsType: "git",
    state: "attached",
    health: { status: "healthy", checkedAt: "2026-09-02T10:00:00.000Z" },
    attachedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

/** An initialised store, so an appended event is admitted rather than buffered. */
export function initialisedStore(sessionId: string): SessionStore {
  const sessionStore = new SessionStore({ sessionId });
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return sessionStore;
}

/** One admitted event of the given kind, numbered so the store's cursor moves. */
export function eventOfKind(
  sessionStore: SessionStore,
  kind: ConsoleSessionEvent["kind"],
  sequence: number,
): ConsoleSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId: sessionStore.sessionId,
    sequence,
    kind,
    occurredAt: "2026-09-02T10:00:00.000Z",
    payload: {},
  };
}
