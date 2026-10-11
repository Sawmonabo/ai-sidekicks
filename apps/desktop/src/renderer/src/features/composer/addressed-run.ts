// Which of the lead's runs the composer is addressed at: the newest live run, one that has not
// settled, else none, and the composer addresses the session. A run apart from the session's
// process, such as a review of the staged set, takes no message, so it is never addressed. A send
// goes onto the session's queue either way; the address names the run the composer reads, which
// "the newest row touched" gets wrong once a run settles.

import { isLiveRunState, readRunState } from "#renderer/services/daemon/wire/identifiers.js";
import { compareInstants, parseInstant } from "#renderer/lib/instant.js";
import type { StoredEntity } from "#renderer/store/session/entities/vocabulary.js";

/** The rank a first candidate takes: newer than nothing. */
const NEWER_THAN_NOTHING = -1;

/**
 * The newest live run (by `touchedAt`) bound to `agentId` and not apart from the session's
 * process, or `undefined`.
 * Ties keep the first seen; a run without `touchedAt` sorts below one that has it.
 */
export function resolveAddressedRun(
  runs: Readonly<Record<string, StoredEntity>>,
  agentId: string,
): StoredEntity | undefined {
  let addressed: StoredEntity | undefined;
  for (const run of Object.values(runs)) {
    // Compared as the daemon sent it; nothing is normalized.
    const boundAgentId: unknown = run.body?.["agentId"];
    // A state the console cannot read, or an absent one, is no live run.
    const state = run.state === undefined ? undefined : readRunState(run.state);
    if (
      boundAgentId !== agentId ||
      run.body?.["isApart"] === true ||
      state === undefined ||
      !isLiveRunState(state)
    ) {
      continue;
    }
    const rankAgainstAddressed =
      addressed === undefined
        ? NEWER_THAN_NOTHING
        : compareInstants(
            parseInstant(run.touchedAt ?? ""),
            parseInstant(addressed.touchedAt ?? ""),
            "newest-first",
          );
    if (rankAgainstAddressed < 0) {
      addressed = run;
    }
  }
  return addressed;
}
