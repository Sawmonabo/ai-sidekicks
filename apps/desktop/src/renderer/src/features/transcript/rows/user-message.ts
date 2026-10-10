// A person's message as its row carries it: the `user.message` payload's `message`. The daemon
// stores the event only once its payload parses against its contract, so the row holds the
// message whole.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { readWireString } from "#renderer/lib/wire/strings.js";
import { projectedPayload } from "#renderer/store/session/events/wire-payload.js";

/** The whole message a `user.message` row carries, or `undefined` where its payload holds none. */
export function userMessageTextOf(row: TranscriptEventRow): string | undefined {
  return readWireString(projectedPayload(row)["message"]);
}
