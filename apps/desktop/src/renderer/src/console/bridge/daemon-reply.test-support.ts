// What both `daemon-reply` suites need before they can call the door.
//
// Two roles, and neither belongs to one concern: the session id every case sends,
// and the reader that takes the refusal off a reply. The parse suite and the
// rejection suite each play both, and a second copy of either would be a second
// place a failure message comes from. It holds nothing a single suite uses — the
// participant id, the instant, the off-contract value, the served reply, and the
// retry-bound reader stay beside their one reader, which is the line
// `fixture-bridge.test-support.ts` next door draws for the same reason.

import type { SessionId } from "@ai-sidekicks/contracts";

import type { ConsoleRefusal } from "../core/index.js";
import type { DaemonReply } from "./daemon-reply.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";

/**
 * A session id the branded schema accepts, taken from a shipped scenario.
 *
 * The cast is the seam in the scenario manifest, not a shortcut taken here: a
 * scenario declares `sessionId` as a plain `string` because it is authored data,
 * and the request schema brands it. `fixture-bridge.relay.test.ts` widens the same
 * value the same way for the same reason. The value still has to satisfy the
 * branded SCHEMA at run time — every case in both suites sends it through the
 * request parse — so a cast to a malformed id fails the assertion rather than
 * slipping past it.
 */
export const SESSION_ID: SessionId = FLAGSHIP_SCENARIO.sessionId as SessionId;

/** The refusal a reply carries, or a failure naming what it carried instead. */
export function refusalOf(reply: DaemonReply<unknown>): ConsoleRefusal {
  if (reply.status !== "refused") {
    throw new Error(`expected a refusal and the call was served with ${JSON.stringify(reply)}`);
  }
  return reply.refusal;
}
