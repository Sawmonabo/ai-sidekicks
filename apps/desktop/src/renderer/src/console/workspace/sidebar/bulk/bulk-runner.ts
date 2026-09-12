// Running one bulk act, and settling every row on its own reply.
//
// A function and not a class: the state a run needs is the selection model's already,
// and a second object holding "which run is in flight" would be a second record of
// what `BulkSelectionModel` publishes. What lives here is the fan-out and the two
// rules the design track states over it.
//
//   • **NEVER ONE ROLLED-UP REFUSAL.** Each item's reply is filed under that item.
//     A run where four items succeed and one refuses shows four successes and one
//     refusal — not "the operation failed", which is both false and unactionable.
//   • **NEVER SEQUENTIALLY AND SILENTLY.** Every row is marked in flight BEFORE the
//     first reply can land, so the surface shows the whole set moving rather than one
//     row at a time with the rest looking untouched.
//
// CONCURRENT, AND BOUNDED BY THE SELECTION ITSELF. The calls go out together because
// they are independent — no row's outcome depends on another's — and the bound is the
// selection, which a person made by hand. There is no queue and no interval here: a
// scheduler would be a second refresh path, and this is not a refresh.

import { type ConsoleBridge } from "../../../bridge/index.js";
import { type SidebarBulkAct, type SidebarBulkItem } from "../../../seats/index.js";
import { SIDEBAR_BULK_ACT_DESCRIPTORS } from "./bulk-acts.js";
import { type BulkSelectionModel } from "./bulk-selection.js";

/** Everything one run needs. Passed rather than reached for, so a test drives it. */
export interface BulkRunRequest {
  readonly model: BulkSelectionModel;
  readonly bridge: ConsoleBridge;
  readonly act: SidebarBulkAct;
}

/**
 * Run one act over every selected row that admits it.
 *
 * Answers when every row has settled, which is what a caller awaits to say the run is
 * over — never what it awaits before showing an outcome, because each row is filed the
 * moment its own reply lands.
 */
export async function runBulkAct(request: BulkRunRequest): Promise<void> {
  const items = request.model.selectedFor(request.act);
  if (items.length === 0) {
    return;
  }
  // Marked in flight in one pass BEFORE any call goes out: `markRunning` also takes
  // the row out of the selection, and a mark-then-call loop would leave the tail of
  // the selection offerable for as long as the head's call took to be issued.
  for (const item of items) {
    request.model.markRunning(item);
  }
  await Promise.all(items.map((item) => settleOne(request, item)));
}

/** One row's call, and the outcome it is filed under. Never throws. */
async function settleOne(request: BulkRunRequest, item: SidebarBulkItem): Promise<void> {
  const descriptor = SIDEBAR_BULK_ACT_DESCRIPTORS[request.act];
  // `callDaemon` answers a refusal rather than rejecting, for every failure it can
  // name — an unsendable request, a wire error, a reply that would not parse. So there
  // is no catch here and no invented refusal beside its vocabulary: a rejection that
  // escaped it would be a defect in the door, and swallowing one here would hide it.
  const reply = await descriptor.call(request.bridge, item.itemId);
  if (reply.status === "refused") {
    request.model.markRefused(item, reply.refusal);
    return;
  }
  request.model.markDone(item);
}
