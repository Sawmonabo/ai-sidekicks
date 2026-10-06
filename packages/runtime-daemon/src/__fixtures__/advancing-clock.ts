/**
 * A test clock whose every call returns a timestamp one second later than the last, so two
 * stamps never tie (`toISOString` has millisecond resolution, and two wall-clock reads
 * microseconds apart give the same string) and a test can tell a write that moved a stamp from
 * one that left it alone.
 */
export function makeAdvancingClock(): () => string {
  let currentMilliseconds: number = Date.parse("2026-06-02T12:00:00.000Z");
  return () => {
    const stamp = new Date(currentMilliseconds).toISOString();
    currentMilliseconds += 1_000;
    return stamp;
  };
}
