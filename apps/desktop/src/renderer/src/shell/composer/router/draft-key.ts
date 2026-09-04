// Which draft belongs to which composer address, stated once.
//
// The window-lifetime `DraftStore` is keyed, and the key is what decides whether a
// remount finds the text again and whether re-addressing the composer carries text
// under a target the person did not write it for. Both failures are silent, so the
// derivation is a pure function with its own test rather than a template literal
// inside a hook.
//
// THE KEY IS THE ADDRESS THE CHIP NAMES, NOT THE RUN THE ROUTER PICKS. A provider-
// bound composer keys on the AGENT: which of that agent's runs a steer lands on is
// `addressed-run.ts`'s resolution and moves as the daemon moves the agent's runs,
// so keying on the run id would empty the line mid-sentence every time a turn
// settled and the next one started. The agent is what the target chip says, and it
// is what the person believes they are writing to.
//
// KEYS ARE OPAQUE AND NEVER PARSED BACK. They address entries in one window's
// `Map`, are never persisted (`console/persistence/draft-store.ts` says why), and
// no reader splits one — so the separator carries no escaping rule, and the fixed
// leading discriminator is what keeps the two arms' key spaces disjoint.

import type { ComposerTarget } from "../chips/chip-models.js";

/** Separates the discriminator from the wire-verbatim identifiers after it. */
const DRAFT_KEY_SEPARATOR = "|";

/**
 * The draft key for one composer address.
 *
 * Total over the send-path union, so a third path has to answer this question
 * rather than falling into another path's key space.
 */
export function composerDraftKey(target: ComposerTarget): string {
  if (target.path === "provider-bound") {
    return [target.path, target.sessionId, target.agentId].join(DRAFT_KEY_SEPARATOR);
  }
  // The empty segment is the session's own default channel — the same absence
  // `run.queueCreate` reads as "the default", kept distinct from a channel whose
  // wire id happens to be read later.
  return [target.path, target.sessionId, target.channelId ?? ""].join(DRAFT_KEY_SEPARATOR);
}
