// What the dev-tier perf meters may hold, kept beside the only registry that spends them
// (`performance-meters.ts`). Each is a retention bound, not a budget target: the budget figures
// the meters are read against (p95 frame time, idle CPU, renderer heap) live in
// `tests/budget/budgets.json`, and restating one here would be a second answer.

/** The retention bounds, by name. */
export const PERFORMANCE_METER_BOUNDS = {
  /**
   * Samples one series retains, oldest dropped first.
   *
   * 240 is four seconds of a 60 Hz lane: long enough that one slow frame does not decide the
   * p95, short enough that an old stall does not color the current reading. At eight bytes a
   * double this is 1,920 bytes a series.
   */
  seriesSampleCount: 240,

  /**
   * Distinct live series one meter tracks before it stops opening new ones.
   *
   * A series is keyed by store scope, which the store registry bounds, or by a producer instance
   * (a transcript feed's frame coordinator, a reveal engine under one), which nothing bounds
   * because feeds mount and unmount. Instances retire their series on dispose, so this caps how
   * many producers are open at once. 64 is far above what a session can hold open; reaching it
   * means a key minted per event or never retired. The meter refuses the next key and counts the
   * refusal rather than growing.
   */
  seriesCount: 64,

  /**
   * Characters a series key is truncated to.
   *
   * Keys are short store-scope, lane and producer-instance identifiers, well inside this. A
   * longer key was never meant to be one (a message body, a path); truncating bounds retained
   * bytes without dropping the reading. Every operation truncates the same way, so a long key
   * still opens, reads and retires one series.
   */
  seriesKeyCharacterCount: 64,

  /**
   * Percentile the reading reports beside its median and its worst sample.
   *
   * 95 because the frame-time budget is stated at p95.
   */
  reportedPercentile: 95,
} as const;
