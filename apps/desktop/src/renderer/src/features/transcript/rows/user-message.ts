// A person's message as its row carries it: the `user.message` payload's `message`. The daemon
// stores the event only once its payload parses against its contract, so the row holds the
// message whole.

import { readWireString } from "#renderer/lib/wire/strings.js";
import { projectedPayload } from "#renderer/store/session/events/wire-payload.js";
import type { ProjectedTranscriptRow } from "#renderer/store/session/entities/vocabulary.js";

/** The whole message a `user.message` row carries, or `undefined` where its payload holds none. */
export function userMessageTextOf(row: ProjectedTranscriptRow): string | undefined {
  return readWireString(projectedPayload(row)["message"]);
}
