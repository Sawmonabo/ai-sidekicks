// The mount inventory: two registered reads composed into one list of mounts.
//
// `Spec-023 §Console Design (Meridian)` §Workspace mounts: "One row per mount with
// its path and its two health axes, read through `repo.mountRead`, re-read on
// focus, on reconnect, and on run-terminal events … Never collapses the two mount
// health axes. Never polls."
//
// WHY TWO READS AND NOT ONE
//
// `repo.mountRead` takes ONE mount id and answers that mount. Nothing in
// `packages/contracts` enumerates mounts: there is no mount-list method, and the
// only registered read that names mount ids at all is `repo.workspaceList`, whose
// every item carries the `repoMountId` its workspace belongs to. So the inventory
// is the distinct mount ids that read names, each then read for the path and the
// health the design's row needs. Inventing a `repo.mountList` string would be
// composing a method the corpus does not register, which the console never does.
//
// The consequence is stated rather than hidden: the list is SESSION-scoped, because
// `repo.workspaceList` is, and the page says so. A node-scoped inventory — every
// mount this machine holds, across sessions — is not reachable from any registered
// read, and a page claiming to show one would be claiming a completeness nothing
// established.
//
// A REFUSED MOUNT IS A ROW, NOT A BLANK PAGE
//
// The per-mount reads settle independently. One mount whose read refuses renders
// its own refusal on its own row while its neighbours render normally — which is
// what "refusals are rendered on the row" requires, and what a single `Promise.all`
// would make impossible by rejecting the whole inventory on the first failure.
//
// THE REFRESH IS THE PAGE'S, AND THERE IS NO PUSH SIGNAL HERE
//
// Mount and workspace lifecycle events are registered session-event types, and the
// surface that refreshes on them is one holding the session's store. The settings
// context deliberately carries no session store (see `settings-page-registry.ts`),
// so this read has no push signal to open — the honest subscribe is the empty one,
// and the page asks for a re-read when the window regains focus, through the
// console's one refresh chokepoint and never a timer.

import type { RepoMountReadResponse, WorkspaceListResponse } from "@ai-sidekicks/contracts";

import type { ConsoleClock, ConsoleRefusal, Unsubscribe } from "../../core/index.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { MOUNT_INVENTORY_READ_CAP } from "../../collaboration/constants.js";
import { PushDrivenRead, consoleRefusalFrom } from "../../collaboration/push-driven-read.js";
import { callDaemonMethod } from "../../collaboration/wire-access.js";

/** The registered method that names which mounts a session holds. */
const WORKSPACE_LIST_METHOD = "repo.workspaceList";

/** The registered method that answers one mount's path and health. */
const MOUNT_READ_METHOD = "repo.mountRead";

/** Names this read in a refusal, so a failure says which read failed. */
export const MOUNT_INVENTORY_ORIGIN = "mount-inventory";

/**
 * One mount's outcome. Two arms, because a mount that could not be read is still a
 * mount this session holds — dropping it would under-report the inventory, and
 * failing the whole list would over-report the damage.
 */
export type MountReading =
  | { readonly kind: "read"; readonly mount: RepoMountReadResponse }
  | {
      readonly kind: "refused";
      readonly repoMountId: string;
      readonly refusal: ConsoleRefusal;
    };

/** What one inventory read answers. */
export interface MountInventory {
  readonly readings: readonly MountReading[];
  /**
   * Mounts the workspace list named and this read did not open, because the cap
   * was reached. Rendered as a count; never silently dropped.
   */
  readonly unreadMountCount: number;
}

/** The read the mounts page is built on, with its refresh already bound. */
export type MountInventoryRead = PushDrivenRead<MountInventory>;

/**
 * Every mount id the session's workspaces name, once each, in a stable order.
 *
 * Sorted rather than left in reply order so two reads of an unchanged session
 * produce the same row order — the reply's order is the workspace list's, and a
 * mount's position in it moves when an unrelated workspace is created.
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
 * Constructed by whoever owns its lifetime — the page's mount effect, never a
 * render body — and disposed with that owner.
 */
export function createMountInventoryRead(options: {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  readonly clock: ConsoleClock;
}): MountInventoryRead {
  const { bridge, sessionId, clock } = options;
  return new PushDrivenRead<MountInventory>({
    clock,
    origin: MOUNT_INVENTORY_ORIGIN,
    read: async () => await readMountInventory(bridge, sessionId),
    subscribe: noMountPushSignal,
  });
}

async function readMountInventory(
  bridge: ConsoleBridge,
  sessionId: string,
): Promise<MountInventory> {
  const workspaces = await callDaemonMethod<{ readonly sessionId: string }, WorkspaceListResponse>(
    bridge,
    WORKSPACE_LIST_METHOD,
    { sessionId },
  );
  const mountIds = distinctMountIds(workspaces);
  const admittedMountIds = mountIds.slice(0, MOUNT_INVENTORY_READ_CAP);
  const settled = await Promise.allSettled(
    admittedMountIds.map(async (repoMountId) =>
      callDaemonMethod<{ readonly repoMountId: string }, RepoMountReadResponse>(
        bridge,
        MOUNT_READ_METHOD,
        { repoMountId },
      ),
    ),
  );
  const readings = settled.map((outcome, index): MountReading => {
    // The id is taken from the request rather than from the reply, because the
    // refused arm has no reply to take it from and both arms must name the same
    // mount for a row to be stable across a refresh.
    const repoMountId = admittedMountIds[index] ?? "";
    return outcome.status === "fulfilled"
      ? { kind: "read", mount: outcome.value }
      : {
          kind: "refused",
          repoMountId,
          refusal: consoleRefusalFrom(outcome.reason, MOUNT_INVENTORY_ORIGIN),
        };
  });
  return { readings, unreadMountCount: mountIds.length - admittedMountIds.length };
}

/**
 * The absent push signal, named rather than written inline.
 *
 * A function that opens nothing and returns an unsubscribe that closes nothing.
 * It exists so the honest fact has a name at the call site: this surface holds no
 * session store, so the session-event stream that would refresh a mount list is
 * not reachable from here.
 */
function noMountPushSignal(): Unsubscribe {
  return () => undefined;
}
