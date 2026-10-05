// Which run a composed message is addressed to: the newest run whose state still admits a steer,
// else none, and the composer addresses the session. Whether the daemon admits the steer is its
// own call; this only picks the run to point at, which "the newest row touched" gets wrong once a
// run settles.

import type { RunState } from "@ai-sidekicks/contracts/run/state";

import { readRunState } from "@renderer/services/daemon/wire-identifiers.js";
import { compareInstants, parseInstant } from "@renderer/lib/instant.js";
import type { StoredEntity } from "@renderer/store/session/entities/entities.js";

/** The rank a first candidate takes: newer than nothing. */
const NEWER_THAN_NOTHING = -1;

/**
 * Whether a run in each state can still take a steer. The `false` rows are the terminal states;
 * `queued` and `starting` are `true` because refusing an accepted, not-yet-started run would
 * queue a second turn behind it. A `Record`, so a state added to the contracts fails to compile.
 */
export const RUN_STATE_ADMITS_STEER: Readonly<Record<RunState, boolean>> = {
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
 * Whether a wire-verbatim state string admits a steer. A value the console cannot read, or an
 * absent one, does not.
 */
export function stateAdmitsSteer(state: string | undefined): boolean {
  if (state === undefined) {
    return false;
  }
  const parsed = readRunState(state);
  return parsed !== undefined && RUN_STATE_ADMITS_STEER[parsed];
}

/**
 * The newest run (by `touchedAt`) bound to `agentId` whose state admits a steer, or `undefined`.
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
    if (boundAgentId !== agentId || !stateAdmitsSteer(run.state)) {
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
