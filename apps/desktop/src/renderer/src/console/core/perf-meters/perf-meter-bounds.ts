// What the dev-tier perf meters are allowed to hold.
//
// A bound TABLE beside its readers, the shape `browser/bounds/browser-bounds.ts`
// established and `core/constants.ts`' header admits: the cap gate reads
// DECLARATIONS, so a record whose keys are the bounds sits with the code that
// spends them while a bare `export const SOMETHING_CAP` would have to live at the
// DAG floor. These four are spent in exactly one module — the registry next door —
// and nothing else in the console reads them.
//
// EVERY ONE OF THEM IS A RETENTION BOUND rather than a budget target. The budget
// figures the meters are read AGAINST — p95 frame time, idle CPU, renderer heap —
// live in `budgets.json`, which is where the measurement tier reads them from, and
// restating one here would be a second answer to what the console is allowed to
// cost. What this table answers is a different question: how much measurement the
// meters may keep while answering it.

/**
 * The retention bounds, by name. Closed — the table IS the declaration, so a fifth
 * bound is a deliberate edit here rather than a number that appeared in the
 * registry.
 *
 * `as const` so each figure is a literal type: a reader that compares against one
 * of these cannot silently be handed a widened `number`.
 */
export const PERF_METER_BOUNDS = {
  /**
   * Samples one series retains, oldest dropped first.
   *
   * 240 is four seconds of a 60 Hz lane, which is the window an author actually
   * reads: long enough that one slow frame does not decide the p95, short enough
   * that a stall two minutes ago is not still colouring the reading of the frame
   * on screen now. At eight bytes a double this is 1,920 bytes a series.
   */
  seriesSampleCount: 240,

  /**
   * Distinct LIVE series one meter tracks before it stops opening new ones.
   *
   * A series is keyed by store scope, which the console's store registry bounds, or
   * by a producer instance — a ledger feed's frame coordinator, and a reveal engine
   * under one — which nothing bounds on its own, because a feed is mounted and
   * unmounted as a person moves around the console. What bounds those is that the
   * instance RETIRES its series when it is disposed, so what this figure caps is how
   * many producers are open at once rather than how many have ever existed. 64 is far
   * above what a session can legitimately hold open, and a run that reaches it is a
   * key being minted per event, or one minted per producer and never retired — the
   * two read the same here, which is why the retiring call sites are named in
   * `perf-meters.ts` rather than left to each producer to remember. The meter refuses
   * the sixty-fifth key and counts the refusal instead of growing: an unbounded map
   * in the module whose job is to report memory pressure would be the defect it
   * exists to find.
   */
  seriesCount: 64,

  /**
   * Characters a series key is truncated to.
   *
   * Keys are store-scope, lane, and producer-instance identifiers, which the console
   * spells short — the longest it composes today is a coordinator's identity and one
   * frame-task key, well inside this. A key longer than this is a value that was
   * never meant to be a key — a message body, a path — and truncating it bounds the
   * map's retained bytes without dropping the reading it labels. Every operation that
   * addresses a series truncates the same way, so a key past the bound still opens,
   * reads, and retires one series rather than opening one it can never close.
   */
  seriesKeyCharacterCount: 64,

  /**
   * Percentile the reading reports beside its median and its worst sample.
   *
   * 95 because that is the percentile the frame-time budget is stated at, so the
   * meter reports the figure the budget is written against rather than one an
   * author has to convert.
   */
  reportedPercentile: 95,
} as const;
