// Which run a composed message is addressed to, and the one question that decides it.
//
// A steer is handed to a run that is still going. The daemon settles a run into
// `completed`, `interrupted`, or `failed` and stops moving it, so a composer that
// kept pointing at a settled run would resolve every later message to the steer
// path and every send would come back refused — with the channel path, which is
// what the person actually wanted, unreachable for the rest of the session.
//
// SO THE ADDRESSED RUN IS THE NEWEST RUN WHOSE STATE STILL ADMITS A STEER, and
// when the agent has none the composer addresses the channel instead. That is a
// narrower claim than deciding eligibility: whether a steer is ADMITTED is the
// daemon's, and it still refuses on the state the run is actually in. What this
// module answers is which run the composer is pointing AT — a question the
// renderer has to answer to address anything at all, and which "the newest row
// this store touched" answers wrongly the moment a run settles.
//
// THE PARTITION IS TOTAL OVER THE CONTRACT'S OWN UNION. `RUN_STATE_ADMITS_STEER`
// is a `Record<RunState, boolean>` rather than a set of literals, so a tenth run
// state added to `packages/contracts` fails to compile here rather than falling
// into whichever half a default happened to pick.

import { RunStateSchema, type RunState } from "@ai-sidekicks/contracts";

import { compareInstants, parseInstant } from "../../../console/core/index.js";
import type { ConsoleEntity } from "../../../console/store/index.js";

/** The rank a first candidate takes: newer than nothing, so it seats. */
const NEWER_THAN_NOTHING = -1;

/**
 * Whether a run in each state is still one a steer can be addressed to.
 *
 * The three `false` rows are the daemon's terminals — a run it will not move
 * again. `queued` and `starting` are `true` because a run the daemon has accepted
 * and not yet started is still the run this agent is on; refusing to address it
 * would send the next message down the new-turn path and queue a second turn
 * behind the one already waiting.
 */
export const RUN_STATE_ADMITS_STEER: Readonly<Record<RunState, boolean>> = {
  queued: true,
  starting: true,
  running: true,
  waiting_for_approval: true,
  waiting_for_input: true,
  paused: true,
  completed: false,
  interrupted: false,
  failed: false,
};

/**
 * Whether one wire-verbatim state string admits a steer.
 *
 * Parsed through the registered schema rather than compared against a copy of the
 * vocabulary: the store holds whatever the daemon said, so a value outside the
 * union is a state this console cannot read — and an unreadable state is not one
 * a steer gets addressed to. Absent is the same answer for the same reason.
 */
export function stateAdmitsSteer(state: string | undefined): boolean {
  if (state === undefined) {
    return false;
  }
  const parsed = RunStateSchema.safeParse(state);
  return parsed.success && RUN_STATE_ADMITS_STEER[parsed.data];
}

/**
 * The run this agent's composer is addressed to, or `undefined` for none.
 *
 * Newest by `touchedAt` among the runs whose state admits a steer. Ties keep the
 * first seen, so the order is total rather than dependent on object-key order —
 * and a run with no `touchedAt` sorts below one that has it, because an unstamped
 * row is one the store has learned less about, not a newer one.
 */
export function resolveAddressedRun(
  runs: Readonly<Record<string, ConsoleEntity>>,
  agentId: string,
): ConsoleEntity | undefined {
  let addressed: ConsoleEntity | undefined;
  for (const run of Object.values(runs)) {
    // The binding is read off the run's own body, wire-verbatim and compared as
    // received — the store holds the daemon's string and this module normalises
    // nothing, so a run bound to another agent simply does not match.
    const boundAgentId: unknown = run.body?.["agentId"];
    if (boundAgentId !== agentId || !stateAdmitsSteer(run.state)) {
      continue;
    }
    // Ranked into a local before it is compared, so the comparison a reader sees is
    // between a rank and zero rather than between two stamps — which is the shape the
    // console's own ban is about, and the shape a later edit could quietly become.
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
