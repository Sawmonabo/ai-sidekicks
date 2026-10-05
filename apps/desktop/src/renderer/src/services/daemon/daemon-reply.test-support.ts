// Reads the refusal off a daemon reply for the `daemon-reply` suite.

import type { Refusal } from "#renderer/lib/refusal/refusal.js";
import type { DaemonReply } from "#renderer/services/daemon/daemon-reply.js";

/** The refusal a reply carries, or a failure naming what it carried instead. */
export function refusalOf(reply: DaemonReply<unknown>): Refusal {
  if (reply.status !== "refused") {
    throw new Error(`expected a refusal and the call was served with ${JSON.stringify(reply)}`);
  }
  return reply.refusal;
}
