import { RefusalError } from "@renderer/lib/refusal/refusal.js";
import type { DaemonReply } from "./daemon-reply.js";

/**
 * The value a daemon reply served, thrown as a `RefusalError` where it refused instead.
 *
 * `callDaemon` never throws, but a `PushDrivenRead` body must return a value or throw. The error
 * is a `RefusalError` so `coerceToRefusal` hands the daemon's refusal back verbatim, keeping its
 * code, sentence and origin.
 */
export function unwrapDaemonReply<TValue>(reply: DaemonReply<TValue>): TValue {
  if (reply.status === "refused") {
    throw new RefusalError(reply.refusal);
  }
  return reply.value;
}
