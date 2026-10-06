/**
 * A clock that advances one second per read, so two stamps never tie: `toISOString` has
 * millisecond resolution and two reads microseconds apart give the same string.
 */
export function steppingClock(): () => string {
  let currentMs: number = Date.parse("2026-08-05T00:00:00.000Z");
  return () => {
    const stamp = new Date(currentMs).toISOString();
    currentMs += 1_000;
    return stamp;
  };
}
