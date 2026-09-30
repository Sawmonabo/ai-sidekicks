// What the `daemon-reply` suites need before they can read a reply: the reader
// that takes the refusal off it. The parse, rejection and abandonment suites each
// use it, and a second copy would be a second place a failure message comes from.
// It holds nothing a single suite uses — the user id, the instant, the
// off-contract value, the served reply, and the retry-bound reader stay beside
// their one reader, which is the line `fixture-bridge.ts` beside it draws for the
// same reason.

import type { Refusal } from "@renderer/lib/refusal.js";
import type { DaemonReply } from "@renderer/services/daemon/daemon-reply.js";

/** The refusal a reply carries, or a failure naming what it carried instead. */
export function refusalOf(reply: DaemonReply<unknown>): Refusal {
  if (reply.status !== "refused") {
    throw new Error(`expected a refusal and the call was served with ${JSON.stringify(reply)}`);
  }
  return reply.refusal;
}
