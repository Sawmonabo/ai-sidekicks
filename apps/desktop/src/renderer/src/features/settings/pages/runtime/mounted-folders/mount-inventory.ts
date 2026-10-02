// The mount inventory: one list of a session's mounts, each with its path and its two
// health axes, composed from two calls the caller supplies.
//
// The workspace list is the only call that names mount ids, and each workspace carries its
// mount; the inventory is the distinct ids it names, each read for its path and health. The
// two axes are never collapsed, and nothing here polls.
//
// It re-reads on focus and on reconnect (both bound in `MountedFolderList`) and on the
// session events below, taken from the session store the window already has open rather
// than a second subscription. Without a store it refreshes on focus alone.
//
// A rejected call is not caught here: it rejects the whole read, and `PushDrivenRead`
// settles it as the read's failed state.

import type {
  RepoMountReadRequest,
  RepoMountReadResponse,
  SessionEventType,
  WorkspaceListRequest,
  WorkspaceListResponse,
} from "@ai-sidekicks/contracts";

import { RefusalError } from "@renderer/lib/refusal.js";
import { MOUNT_INVENTORY_READ_CAP } from "./mount-inventory-caps.js";
import { type Clock } from "@renderer/lib/clock.js";
import { type Unsubscribe } from "@renderer/lib/emitter.js";
import { abandonedReadRefusal } from "@renderer/services/daemon/daemon-reply.js";
import { heldIdAsWireId } from "@renderer/services/daemon/wire-ids.js";
import { PushDrivenRead } from "@renderer/store/reads/push-driven-read.js";
import { isReadAbandoned } from "@renderer/lib/reads/read-scope.js";
import { subscribeToSessionEventKinds } from "@renderer/store/session/session-event-signal.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";

/** Names this read in a refusal, so a failure says which read failed. */
export const MOUNT_INVENTORY_ORIGIN = "mount-inventory";

/** The call that lists a session's workspaces, each naming the mount it belongs to. */
export type WorkspaceListCall = (
  request: WorkspaceListRequest,
  signal: AbortSignal,
) => Promise<WorkspaceListResponse>;

/** The call that answers one mount's path and health. */
export type MountReadCall = (
  request: RepoMountReadRequest,
  signal: AbortSignal,
) => Promise<RepoMountReadResponse>;

/** The two calls the inventory is composed from. */
export interface MountInventoryCalls {
  readonly workspaceList: WorkspaceListCall;
  readonly mountRead: MountReadCall;
}

/**
 * Every session event kind that can change what this list says.
 *
 * The `workspace.*` lifecycle kinds change which mounts the workspace list names; a run
 * ending re-probes the worktree it executed in, so health moves at those three run kinds.
 * A run beginning changes neither axis. Typed as the contract's own census, so a kind the
 * daemon never sends fails to compile.
 */
const MOUNT_AFFECTING_EVENT_KINDS: readonly SessionEventType[] = [
  "workspace.preparing",
  "workspace.ready",
  "workspace.stale",
  "workspace.archived",
  "run.completed",
  "run.failed",
  "run.interrupted",
];

/** What one inventory read answers. */
export interface MountInventory {
  readonly readings: readonly RepoMountReadResponse[];
  /**
   * Mounts the workspace list named and this read did not open because the cap was
   * reached. Rendered as a count, never dropped.
   */
  readonly unreadMountCount: number;
}

/** The read `Folders this machine can reach` is built on, with its refresh already bound. */
export type MountInventoryRead = PushDrivenRead<MountInventory>;

/**
 * Every mount id the session's workspaces name, once each, in a stable order.
 *
 * Sorted so two reads of an unchanged session give the same row order: the workspace list's
 * order moves when an unrelated workspace is created.
 */
export function distinctMountIds(response: WorkspaceListResponse): readonly string[] {
  const seen = new Set<string>();
  for (const workspace of response.workspaces) {
    seen.add(workspace.repoMountId);
  }
  return [...seen].sort();
}

/**
 * Build the inventory read for one session.
 *
 * Constructed by whoever owns its lifetime (a mount effect, never a render body) and
 * disposed with that owner.
 */
export function createMountInventoryRead(options: {
  readonly calls: MountInventoryCalls;
  readonly sessionId: string;
  readonly clock: Clock;
  /**
   * The retained session's store, where this window has one open.
   *
   * `undefined` is a real answer, not a defect: settings can open with no session. It
   * costs this read its push signal and nothing else.
   */
  readonly sessionStore: SessionStore | undefined;
}): MountInventoryRead {
  const { calls, sessionId, clock, sessionStore } = options;
  return new PushDrivenRead<MountInventory>({
    clock,
    origin: MOUNT_INVENTORY_ORIGIN,
    read: async (signal: AbortSignal) => await readMountInventory(calls, sessionId, signal),
    // One re-read per burst: the signal goes to the read's `RefreshScheduler`, which
    // debounces with an absolute deadline, so a run ending three worktrees at once costs one
    // inventory read.
    subscribe:
      sessionStore === undefined
        ? noSessionStoreOpen
        : (onChangeSignal) =>
            subscribeToSessionEventKinds(sessionStore, MOUNT_AFFECTING_EVENT_KINDS, onChangeSignal),
  });
}

/**
 * The fan-out read: the workspace list, then up to `MOUNT_INVENTORY_READ_CAP` mount reads.
 *
 * The signal reaches every call and is read again between them, so a page that has left
 * cancels calls in flight and an abort in either gap stops the fan-out. Exported so both
 * checkpoints are drivable at their own boundary.
 */
export async function readMountInventory(
  calls: MountInventoryCalls,
  sessionId: string,
  signal: AbortSignal,
): Promise<MountInventory> {
  const workspaces = await calls.workspaceList({ sessionId: heldIdAsWireId(sessionId) }, signal);
  if (isReadAbandoned(signal)) {
    raiseAbandonedInventoryRead();
  }
  const mountIds = distinctMountIds(workspaces);
  const admittedMountIds = mountIds.slice(0, MOUNT_INVENTORY_READ_CAP);
  const readings = await Promise.all(
    admittedMountIds.map(
      async (repoMountId) =>
        await calls.mountRead({ repoMountId: heldIdAsWireId(repoMountId) }, signal),
    ),
  );
  if (isReadAbandoned(signal)) {
    raiseAbandonedInventoryRead();
  }
  return { readings, unreadMountCount: mountIds.length - admittedMountIds.length };
}

/**
 * Stop the read where nobody is waiting for the mounts any more.
 *
 * Raised rather than returned: `PushDrivenRead` sees its own round's signal aborted
 * and reports nothing, where an empty inventory would be a reading never taken.
 */
function raiseAbandonedInventoryRead(): never {
  throw new RefusalError(abandonedReadRefusal("mount inventory"));
}

/** The subscribe for a window with no session store open: nothing to bind, nothing to release. */
function noSessionStoreOpen(): Unsubscribe {
  return () => undefined;
}
