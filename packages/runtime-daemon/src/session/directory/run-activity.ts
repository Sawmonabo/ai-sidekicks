// A session's activity: `waiting` while any of its runs in `runs` waits on the person, else
// `running` while any of them works, else how its last run ended, which each run's end event
// writes to `sessions.last_run_outcome`. A run reads as it does until its state changes.

import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { RunState } from "@ai-sidekicks/contracts/run/state";

import { sqlListOf } from "../../database/sql-list.js";
import type { SessionRunOutcome } from "../records.js";

// The run states a session reads as waiting on the person, and those it reads as working.
const WAITING_RUN_STATES: readonly RunState[] = ["waiting_for_approval", "waiting_for_input"];
const WORKING_RUN_STATES: readonly RunState[] = ["starting", "running", "pausing"];

// Reads how a run's end event leaves its session, from the event's payload.
type RunOutcomeOf = (payload: Readonly<Record<string, unknown>>) => SessionRunOutcome;

/**
 * The run events that end a run's working time, each with how it leaves the session. A paused run
 * can go on, but its session reads idle until it does.
 */
export const RUN_OUTCOME_BY_EVENT_TYPE: Readonly<Partial<Record<SessionEventType, RunOutcomeOf>>> =
  {
    "run.completed": () => "done",
    // A terminal the daemon's own close produced is never read as a crash.
    "run.failed": (payload) => (payload["intendedClose"] === true ? "idle" : "failed"),
    "run.interrupted": () => "idle",
    "run.stopped": () => "idle",
    "run.paused": () => "idle",
  };

/**
 * The SQL of a session's activity, from the session id's SQL and its `last_run_outcome`'s. Each
 * read is an indexed lookup of the session's runs.
 */
export function sessionActivitySql(sessionIdSql: string, lastRunOutcomeSql: string): string {
  const isAnyRunIn = (states: readonly RunState[]): string =>
    `EXISTS (SELECT 1 FROM runs WHERE runs.session_id = ${sessionIdSql}
                AND runs.state IN (${sqlListOf(states)}))`;
  return `CASE WHEN ${isAnyRunIn(WAITING_RUN_STATES)} THEN 'waiting'
               WHEN ${isAnyRunIn(WORKING_RUN_STATES)} THEN 'running'
               ELSE ${lastRunOutcomeSql} END`;
}
