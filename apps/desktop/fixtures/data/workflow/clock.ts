// The instant the workflow fixtures call now, and the instants measured from it.
//
// Every instant is a whole number of minutes before the scenario's start, built from the epoch
// rather than parsed, so no stamp depends on the host's zone.

/** The instant the playback calls now, matching the scenario these replies are spread into. */
export const WORKFLOW_FIXTURE_NOW_MS: number = Date.UTC(2026, 0, 1, 14, 20);

/** The ISO instant `minutesBefore` minutes before now. */
export function minutesAgo(minutesBefore: number): string {
  return new Date(WORKFLOW_FIXTURE_NOW_MS - minutesBefore * 60_000).toISOString();
}

/** The ISO instant `minutesAfter` minutes after now. */
export function minutesAhead(minutesAfter: number): string {
  return new Date(WORKFLOW_FIXTURE_NOW_MS + minutesAfter * 60_000).toISOString();
}
