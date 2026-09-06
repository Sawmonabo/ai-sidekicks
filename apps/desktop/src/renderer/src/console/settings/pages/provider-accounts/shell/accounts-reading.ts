// The registry read the accounts shell is built on: one reply, two refresh signals.
//
// ONE READ AND NOT FOUR. The registry list, the per-limit quota rows, and the
// readiness projection all arrive on `providerAccount.list` — the reply is a single
// snapshot of the account plane — so a page that issued three calls would produce three
// arrival orders for one registry with nothing able to say which was right.
//
// WHICH SIGNALS REFRESH IT.
//
//   • **Focus** — installed beside the read by the component that owns its lifetime.
//   • **Reconnect** — the console's one transport signal, off `ConsoleBridge`. A window
//     that never lost focus can still have read every figure here across a gap in the
//     wire.
//
// There is deliberately no timer: the section's rule is "never polls", and re-reading
// on an interval to make up for a signal this shell does not bind would be exactly the
// poll it forbids.
//
// AND THERE IS DELIBERATELY NO THIRD SIGNAL HERE. The registry's own live tail is
// `providerAccount.subscribe`, which the console already opens — once, node-scoped, in
// `bridge/quotas/` — and binding a second subscription to it from a settings page would
// be a second copy of one feed. The owning page body takes that signal when it mounts;
// what the mount owes it is recorded on the seat's contract next door.

import { type ProviderAccountListResponse } from "@ai-sidekicks/contracts";

import { callDaemon, type ConsoleBridge } from "../../../../bridge/index.js";
import type { ConsoleClock, Unsubscribe } from "../../../../core/index.js";
import { PushDrivenRead, servedValueOrRaise } from "../../../../seats/index.js";

/** Names this read in a refusal, so a failure says which read failed. */
export const ACCOUNT_REGISTRY_READ_ORIGIN = "provider-accounts";

/** The registered method this shell reads the account plane through. */
const PROVIDER_ACCOUNT_LIST_METHOD = "providerAccount.list";

/** The read the accounts shell is built on, with its refresh already bound. */
export type AccountRegistryRead = PushDrivenRead<ProviderAccountListResponse>;

/**
 * Build the registry read.
 *
 * Constructed by whoever owns its lifetime — the shell's mount effect, never a render
 * body — and disposed with that owner.
 *
 * `subscribe` opens nothing, and that is stated rather than left as an empty function
 * at the call site: the account plane's live tail is node-scoped and already open
 * elsewhere in this window, so there is no stream for this read to bind and the two
 * signals it does have are installed by its owner.
 */
export function createAccountRegistryRead(options: {
  readonly bridge: ConsoleBridge;
  readonly clock: ConsoleClock;
}): AccountRegistryRead {
  const { bridge, clock } = options;
  return new PushDrivenRead<ProviderAccountListResponse>({
    clock,
    origin: ACCOUNT_REGISTRY_READ_ORIGIN,
    // `servedValueOrRaise` rather than a hand-written arm: the reply is parsed both
    // directions at the call door, and a refusal it returns is raised so the read's own
    // `failed` state carries the daemon's code and sentence rather than this module
    // inventing one.
    read: async () =>
      servedValueOrRaise(await callDaemon(bridge, PROVIDER_ACCOUNT_LIST_METHOD, {})),
    subscribe: noRegistryTailBoundHere,
  });
}

/**
 * The subscribe for a read whose live tail is somebody else's, named rather than
 * inline.
 *
 * It opens nothing and returns an unsubscribe that closes nothing, so the honest fact
 * has a name where a reader meets it: the console HAS a registry tail and this read is
 * not the thing that owns it.
 */
function noRegistryTailBoundHere(): Unsubscribe {
  return () => undefined;
}
