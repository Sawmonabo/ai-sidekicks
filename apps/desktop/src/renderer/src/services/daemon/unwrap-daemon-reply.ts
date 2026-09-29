import { RefusalError } from "@renderer/lib/refusal.js";
import type { DaemonReply } from "./daemon-reply.js";

/**
 * The value a daemon reply served, raised as a throw where it refused instead.
 *
 * The call door answers a closed `served | refused` value and never throws, and a
 * read body here has to answer a VALUE or throw, because rule 1 puts the subscribe
 * first and the failure arm this model settles into is fed by its own `catch`. So
 * the two shapes meet in exactly one place, here, rather than in a four-line branch
 * at each of the console's live reads.
 *
 * A `RefusalError` and not a bare `Error`, so {@link coerceToRefusal} on
 * the other side of that `catch` recognises it and hands the door's refusal back
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
