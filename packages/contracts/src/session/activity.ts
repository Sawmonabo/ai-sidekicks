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
  return nowMs >= sessionActivityLapsesAt(activity, activityRenewedAt) ? "idle" : activity;
}

/**
 * The first instant, in milliseconds since the Unix epoch, at which {@link sessionActivityAsOf}
 * reads this word as `idle`, so a view can wake once then instead of polling. `Infinity` for a
 * word that never ages and for a renewal instant that does not parse.
 */
export function sessionActivityLapsesAt(
  activity: SessionActivity,
  activityRenewedAt: string,
): number {
  const renewedAtMs = Date.parse(activityRenewedAt);
  if ((activity !== "running" && activity !== "waiting") || Number.isNaN(renewedAtMs)) {
    return Number.POSITIVE_INFINITY;
  }
  // The reading stands at exactly the stale bound and lapses the millisecond after it.
  return renewedAtMs + SESSION_ACTIVITY_STALE_AFTER_MS + 1;
}
