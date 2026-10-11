// Which draft belongs to which composer. A wrong key is silent: a remount loses the text, or a
// change of address carries it somewhere the person did not write it.
//
// The draft is the session's, so the key names the session and nothing the address resolves to:
// the lead's run starts and settles while a person types, and a key that followed it would empty
// the line mid-sentence. Keys are opaque, never parsed back or persisted; the leading word keeps
// the composer's keys apart from any other draft the window's store holds.

import { structuralKey } from "#renderer/lib/structural-key.js";

/** The draft key for one session's composer. */
export function composerDraftKey(sessionId: string): string {
  return structuralKey(["composer", sessionId]);
}
