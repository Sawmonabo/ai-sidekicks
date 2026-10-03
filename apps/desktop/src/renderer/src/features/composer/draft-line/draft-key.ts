// Which draft belongs to which composer address. A wrong key is silent: a remount loses the
// text, or re-addressing carries it under a target the person did not write it for.
//
// A provider-bound composer keys on the agent the chip names, not the run the router picks:
// the run changes every turn and would empty the line mid-sentence. Keys are opaque, never
// parsed back or persisted; the leading discriminator keeps the two paths' key spaces disjoint.

import { structuralKey } from "@renderer/lib/structural-key.js";
import type { ComposerTarget } from "../composer-target.js";

/** The draft key for one composer address; total over the send-path union. */
export function composerDraftKey(target: ComposerTarget): string {
  if (target.path === "provider-bound") {
    return structuralKey([target.path, target.sessionId, target.agentId]);
  }
  return structuralKey([target.path, target.sessionId]);
}
