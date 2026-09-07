// The three bulk acts, and the wire each one sends.
//
// `Spec-023 §Console Design (Meridian)` §The surface set offers "bulk operations where
// a verb exists for each item and the operation is batched with per-item results:
// cancel several queued items, revoke several invites, retire several worktrees". The
// conjunct that governs this file is the FIRST one: a verb exists for each item. All
// three verbs are registered on the console's own daemon-method contract, so nothing
// here reaches the growth port and no act is offered that has no wire.
//
// ONE CALL PER ITEM, AND THAT IS THE POINT. "Batched" here means the person acts once,
// not that the wire carries one request: no registered method takes a set, and a
// console that invented one would be inventing a wire. So the batch is a fan-out and
// each item's own reply is what settles it — which is exactly what makes the design
// track's "never runs a bulk operation sequentially and silently" checkable.
//
// THE TABLE IS TOTAL OVER THE ACT SET. A fourth act fails to compile here rather than
// rendering a button that sends nothing.

import { callDaemon, heldIdAsWireId, type DaemonReply } from "../../../bridge/index.js";
import { type ConsoleBridge } from "../../../bridge/index.js";
import { type SidebarBulkAct } from "../../../seats/index.js";

/**
 * What one bulk act is called, and how it reaches the daemon.
 *
 * `call` answers a reply whose value is deliberately `unknown`: the runner reads
 * `status` and the refusal beside it and nothing else, and a served value it could
 * read would invite a surface to move a row on the strength of a reply rather than on
 * the event that says the daemon moved it.
 */
export interface SidebarBulkActDescriptor {
  /** The button on the action bar, with the count filled in by the bar itself. */
  readonly label: string;
  /** What the destructive confirm's own button says. One verb, imperative. */
  readonly confirmVerb: string;
  /** What the confirm says is about to happen, ahead of the list of items. */
  readonly describe: (itemCount: number) => string;
  readonly call: (
    bridge: ConsoleBridge,
    sessionId: string,
    itemId: string,
  ) => Promise<DaemonReply<unknown>>;
}

/**
 * Every act, with the method it sends.
 *
 * The methods are named as literals at each call site rather than held as data,
 * because `callDaemon` types the request from the method name — a table holding the
 * method as a string would have to widen the request to `unknown` and would lose
 * exactly the check that makes a malformed request a compile error.
 */
export const SIDEBAR_BULK_ACT_DESCRIPTORS: Readonly<
  Record<SidebarBulkAct, SidebarBulkActDescriptor>
> = {
  "cancel-queue-item": {
    label: "Cancel queued",
    confirmVerb: "Cancel",
    describe: (itemCount) =>
      `${describeCount(itemCount, "queued item", "queued items")} will be cancelled before admission.`,
    call: (bridge, _sessionId, itemId) =>
      callDaemon(bridge, "run.queueCancel", { queueItemId: heldIdAsWireId(itemId) }),
  },
  "revoke-invite": {
    label: "Revoke invites",
    confirmVerb: "Revoke",
    describe: (itemCount) =>
      `${describeCount(itemCount, "invite", "invites")} will be revoked and can no longer be redeemed.`,
    call: (bridge, sessionId, itemId) =>
      callDaemon(bridge, "invite.revoke", {
        sessionId: heldIdAsWireId(sessionId),
        inviteId: heldIdAsWireId(itemId),
      }),
  },
  "retire-worktree": {
    label: "Retire worktrees",
    confirmVerb: "Retire",
    describe: (itemCount) =>
      `${describeCount(itemCount, "worktree", "worktrees")} will be retired. The record survives; the checkout is reclaimed afterwards.`,
    call: (bridge, _sessionId, itemId) =>
      callDaemon(bridge, "repo.worktreeRetire", { worktreeId: heldIdAsWireId(itemId) }),
  },
};

/**
 * "One invite" / "Three invites", as a sentence opener.
 *
 * The console's own reading of its own selection rather than a wire figure, so it is
 * plain prose; the figures rule reserves the mono class for values the daemon sent.
 */
function describeCount(itemCount: number, singular: string, plural: string): string {
  return itemCount === 1 ? `One ${singular}` : `${String(itemCount)} ${plural}`;
}
