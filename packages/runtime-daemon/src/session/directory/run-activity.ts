// What each run lifecycle event does to its session's live runs, and the one activity reading
// derived from them. A run type not in the table leaves the live runs as they were.

import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { SessionActivity } from "@ai-sidekicks/contracts/session/directory";

import type { LiveRunActivity, SessionDirectoryRow, SessionRunOutcome } from "../records.js";

/** A run event's effect: the run is live doing `live`, or it left the live set with `ended`. */
export type RunActivityEffect =
  | { readonly live: LiveRunActivity }
  | { readonly ended: SessionRunOutcome };

// Reads one run event's effect from its payload.
type RunActivityEffectOf = (payload: Readonly<Record<string, unknown>>) => RunActivityEffect;

const RUNNING: RunActivityEffect = { live: "running" };
const WAITING: RunActivityEffect = { live: "waiting" };
const ENDED_IDLE: RunActivityEffect = { ended: "idle" };

/**
 * The closed run-event table. `run.queued` (not yet executing), `run.rolled_back` (the run keeps
 * its state), `run.worker_shutdown` (a diagnostic; the terminal follows) and the recovery events
 * are absent on purpose.
 */
export const RUN_ACTIVITY_BY_EVENT_TYPE: Readonly<
  Partial<Record<SessionEventType, RunActivityEffectOf>>
> = {
  "run.starting": () => RUNNING,
  "run.running": () => RUNNING,
  "run.provider_initialized": () => RUNNING,
  "run.turn_started": () => RUNNING,
  // The step in flight is still finishing.
  "run.pausing": () => RUNNING,
  "run.waiting_for_approval": () => WAITING,
  "run.waiting_for_input": () => WAITING,
  // The run waits for input while either choice is open, and goes on once it is answered; an
  // answer that ends the run is followed by its terminal event.
  "run.refusal_choice_requested": () => WAITING,
  "run.usage_credits_choice_requested": () => WAITING,
  "run.refusal_choice_resolved": () => RUNNING,
  "run.usage_credits_choice_resolved": () => RUNNING,
  "run.completed": () => ({ ended: "done" }),
  // A terminal the daemon's own close produced is never read as a crash.
  "run.failed": (payload) => ({ ended: payload["intendedClose"] === true ? "idle" : "failed" }),
  "run.interrupted": () => ENDED_IDLE,
  "run.stopped": () => ENDED_IDLE,
  "run.paused": () => ENDED_IDLE,
  "run.step_limit_reached": () => ENDED_IDLE,
  "run.token_limit_reached": () => ENDED_IDLE,
};

/**
 * The one activity reading for a session: `waiting` while any live run waits on the person, else
 * `running` while any runs, else how its last run ended.
 */
export function sessionActivityOf(
  row: Pick<SessionDirectoryRow, "liveRuns" | "lastRunOutcome">,
): SessionActivity {
  const activities = [...row.liveRuns.values()];
  if (activities.includes("waiting")) return "waiting";
  if (activities.includes("running")) return "running";
  return row.lastRunOutcome;
}
