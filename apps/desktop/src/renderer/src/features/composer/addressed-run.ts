// Which run a composed message is addressed to: the newest live run, one that has not settled,
// else none, and the composer addresses the session. Whether the daemon takes the message is its
// own call; this only picks the run to point at, which "the newest row touched" gets wrong once a
// run settles.

import type { RunState } from "@ai-sidekicks/contracts/run/state";

import { readRunState } from "#renderer/services/daemon/wire/identifiers.js";
import { compareInstants, parseInstant } from "#renderer/lib/instant.js";
import type { StoredEntity } from "#renderer/store/session/entities/vocabulary.js";

/** The rank a first candidate takes: newer than nothing. */
const NEWER_THAN_NOTHING = -1;

/**
 * The newest live run (by `touchedAt`) bound to `agentId`, or `undefined`.
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
    if (boundAgentId !== agentId || !isLiveRunState(run.state)) {
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

/**
 * Whether a run in each state is live: not settled, so a message sent now goes into it. The
 * `false` rows are the terminal states; `queued` and `starting` are `true` because the run has
 * been accepted and a message waits for it. A `Record`, so a state added to the contracts fails to
 * compile.
 */
const RUN_STATE_IS_LIVE: Readonly<Record<RunState, boolean>> = {
  queued: true,
  starting: true,
  running: true,
  waiting_for_approval: true,
  waiting_for_input: true,
  pausing: true,
  paused: true,
  completed: false,
  interrupted: false,
  stopped: false,
  failed: false,
};

/**
 * Whether a wire-verbatim state string names a live run. A value the console cannot read, or an
 * absent one, does not.
 */
function isLiveRunState(state: string | undefined): boolean {
  if (state === undefined) {
    return false;
  }
  const parsed = readRunState(state);
  return parsed !== undefined && RUN_STATE_IS_LIVE[parsed];
}
