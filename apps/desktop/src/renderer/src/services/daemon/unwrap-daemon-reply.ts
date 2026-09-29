import { RefusalError } from "@renderer/lib/refusal.js";
import type { DaemonReply } from "./daemon-reply.js";

/**
 * The value a daemon reply served, raised as a throw where it refused instead.
 *
 * `callDaemon` answers a closed `served | refused` value and never throws, and a
 * read body handed to `PushDrivenRead` has to answer a VALUE or throw, because that
 * read opens its subscription before it reads and settles into `failed` from its own
 * `catch`. So the two shapes meet in exactly one place, here, rather than in a
 * four-line branch at each of the console's live reads.
 *
 * A `RefusalError` and not a bare `Error`, so {@link coerceToRefusal} on
 * the other side of that `catch` recognizes it and hands `callDaemon`'s refusal back
 * VERBATIM — the code the daemon wrote, the sentence it wrote, the origin that says
 * which seam answered. Wrapping it in anything else would relabel a permission
 * denial as `read-failed` on the way through the very mechanism that exists to stop
 * that.
 */
export function unwrapDaemonReply<TValue>(reply: DaemonReply<TValue>): TValue {
  if (reply.status === "refused") {
    throw new RefusalError(reply.refusal);
  }
  return reply.value;
}
