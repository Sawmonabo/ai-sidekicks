// How a reader ages a sessions-list row's activity word, so a service that stopped publishing never
// leaves a row claiming work.
import {
  SESSION_ACTIVITY_STALE_AFTER_MS,
  type SessionActivity,
} from "../generated/session/directory.js";

/**
 * The activity a reader shows at `nowMs` (milliseconds since the Unix epoch) for a word renewed at
 * `activityRenewedAt`: a `running` or `waiting` reading renewed longer ago than
 * `SESSION_ACTIVITY_STALE_AFTER_MS` reads as `idle`. Every other word stands as published; a
 * `failed` session never ages out of being failed.
 */
export function sessionActivityAsOf(
  activity: SessionActivity,
  activityRenewedAt: string,
  nowMs: number,
): SessionActivity {
  if (activity !== "running" && activity !== "waiting") {
    return activity;
  }
  return nowMs - Date.parse(activityRenewedAt) > SESSION_ACTIVITY_STALE_AFTER_MS
    ? "idle"
    : activity;
}
