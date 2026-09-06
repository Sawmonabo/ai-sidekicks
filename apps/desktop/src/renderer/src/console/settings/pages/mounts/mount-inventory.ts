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
// WHICH SIGNALS REFRESH IT, AND THE ONE THE CONSOLE DOES NOT HAVE
//
// The section names three: focus, reconnect, and run-terminal events. Two of the
// three are bound, and the third is absent from the whole console rather than from
// this read.
//
//   • **Focus** is the page's, installed beside the read (`WorkspaceMountsPage`).
//   • **The session's own event stream** carries every kind that can change what
//     this list says. Nine of them, and each is a registered `SessionEventType`
//     rather than a guess — the mount's own attachment lifecycle, the workspace
//     lifecycle the inventory is DERIVED from, and the three run terminals the
//     section names, since a run ending is what re-probes a worktree's health.
//     The signal arrives through the console's own session store rather than
//     through a second `daemon.subscribe`, exactly as the channel directory takes
//     its own: the store is already the one subscriber to that stream, and opening
//     another would be a second copy of the same feed arriving in a different
//     order.
//   • **Reconnect** is the console's one transport signal, taken from
//     `ConsoleBridge.transportReconnect` and bound beside the focus listener in
//     `MountInventoryList`. It is a different fact from the two above it: a window
//     that never lost focus, in a session that never went degraded, can still have
//     had its transport drop and come back — and every mount health this list is
//     showing was read before that gap. The signal is OBSERVED rather than guessed:
//     the live half is what the session-event binder saw happen to the one
//     subscription this window takes, and the fixture half is a scenario's scripted
//     outage. This module still composes nothing of its own; it asks for a read.
//
// THE STORE IS OPTIONAL, AND ITS ABSENCE IS A REAL STATE. Settings is reachable
// with no session open, and the retained session's store is `undefined` until the
// window opens it. The read still performs — the wire call needs only a session id
// — and refreshes on focus alone until a store arrives, which is one signal fewer
// rather than a stale list nothing can correct.

import type {
  RepoMountReadRequest,
  RepoMountReadResponse,
  SessionEventType,
  WorkspaceListResponse,
} from "@ai-sidekicks/contracts";

import type { ConsoleClock, ConsoleRefusal, Unsubscribe } from "../../../core/index.js";
import { callDaemon, heldIdAsWireId, type ConsoleBridge } from "../../../bridge/index.js";
import { MOUNT_INVENTORY_READ_CAP } from "../../../core/index.js";
import { PushDrivenRead, servedValueOrRaise } from "../../../seats/index.js";
import { subscribeToSessionEventKinds, type SessionStore } from "../../../store/index.js";

/** The registered method that names which mounts a session holds. */
const WORKSPACE_LIST_METHOD = "repo.workspaceList";

/** The registered method that answers one mount's path and health. */
const MOUNT_READ_METHOD = "repo.mountRead";

/** Names this read in a refusal, so a failure says which read failed. */
export const MOUNT_INVENTORY_ORIGIN = "mount-inventory";

/**
 * Every registered event kind that can change what this list says.
 *
 * Three groups, and each earns its place from what the inventory is BUILT from
 * rather than from what sounds related:
 *
 *   • `repo.attached` / `repo.detached` — the attachment axis one row renders. A
 *     mount that detaches while this page is open is a row whose first chip is now
 *     wrong.
 *   • The four `workspace.*` lifecycle kinds — the inventory's mount ids come from
 *     `repo.workspaceList`, so a workspace arriving or being archived changes WHICH
 *     mounts this session names, not merely how one of them is doing.
 *   • `run.completed` / `run.failed` / `run.interrupted` — the section's own named
 *     trigger. A run ending is what re-probes the worktree it was executing in, so
 *     the reachability axis moves at exactly these three instants.
 *
 * `run.queued`, `run.starting` and the rest of the transitions are deliberately
 * absent: a run beginning changes neither axis, and a subscription that woke on
 * every transition would re-read the whole inventory through a run's lifetime for
 * two readings that did not move.
 *
 * Typed as the contract's own census member, so a kind this console invents fails
 * to compile rather than subscribing to a name the daemon never sends.
 */
const MOUNT_AFFECTING_EVENT_KINDS: readonly SessionEventType[] = [
  "repo.attached",
  "repo.detached",
  "workspace.provisioning",
  "workspace.ready",
  "workspace.stale",
  "workspace.archived",
  "run.completed",
  "run.failed",
  "run.interrupted",
];

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
  /**
   * The retained session's store, where this window has one open.
   *
   * `undefined` is a real answer rather than a defect — settings opens with no
   * session — and it costs this read its push signal and nothing else.
   */
  readonly sessionStore: SessionStore | undefined;
}): MountInventoryRead {
  const { bridge, sessionId, clock, sessionStore } = options;
  return new PushDrivenRead<MountInventory>({
    clock,
    origin: MOUNT_INVENTORY_ORIGIN,
    read: async () => await readMountInventory(bridge, sessionId),
    // One re-read per burst, never one per event: the signal goes to the read's own
    // `RefreshScheduler`, which debounces with an absolute deadline, so a run ending
    // three worktrees at once costs one inventory read rather than three.
    subscribe:
      sessionStore === undefined
        ? noSessionStoreOpen
        : (onChangeSignal) =>
            subscribeToSessionEventKinds(sessionStore, MOUNT_AFFECTING_EVENT_KINDS, onChangeSignal),
  });
}

async function readMountInventory(
  bridge: ConsoleBridge,
  sessionId: string,
): Promise<MountInventory> {
  const workspaces = servedValueOrRaise(
    await callDaemon(bridge, WORKSPACE_LIST_METHOD, {
      sessionId: heldIdAsWireId(sessionId),
    }),
  );
  const mountIds = distinctMountIds(workspaces);
  const admittedMountIds = mountIds.slice(0, MOUNT_INVENTORY_READ_CAP);
  // `Promise.all` and not `allSettled`, because the call door answers a refusal as a
  // VALUE: one mount refusing no longer rejects, so there is no settled-outcome
  // wrapper left to unwrap and no `reason` left to normalize a second time.
  const replies = await Promise.all(
    admittedMountIds.map(async (repoMountId) => await readOneMount(bridge, repoMountId)),
  );
  const readings = replies.map((reply, index): MountReading => {
    // The id is taken from the request rather than from the reply, because the
    // refused arm has no reply to take it from and both arms must name the same
    // mount for a row to be stable across a refresh.
    const repoMountId = admittedMountIds[index] ?? "";
    return reply.status === "served"
      ? { kind: "read", mount: reply.value }
      : { kind: "refused", repoMountId, refusal: reply.refusal };
  });
  return { readings, unreadMountCount: mountIds.length - admittedMountIds.length };
}

/**
 * One mount read, as its own function so the branded request infers in one place.
 *
 * The request is a NAMED local carrying the contracts type rather than an object
 * literal in the argument position. Written inline, the widening sits inside a
 * generic call whose own method parameter is still being inferred, the brand
 * resolves to bare `string`, and the widening does nothing. It fails loudly — the
 * assignment is the error above — but the fix belongs at the site rather than in a
 * reader's memory, so the type is written where it is decided.
 */
async function readOneMount(bridge: ConsoleBridge, repoMountId: string) {
  const request: RepoMountReadRequest = { repoMountId: heldIdAsWireId(repoMountId) };
  return await callDaemon(bridge, MOUNT_READ_METHOD, request);
}

/**
 * The subscribe for a window with no session store open, named rather than inline.
 *
 * A function that opens nothing and returns an unsubscribe that closes nothing. It
 * exists so the honest fact has a name at the call site: there is no stream to bind
 * because this window has no store for the session, NOT because the console has no
 * signal for a mount — it has nine, and they are bound the moment a store arrives.
 */
function noSessionStoreOpen(): Unsubscribe {
  return () => undefined;
}
