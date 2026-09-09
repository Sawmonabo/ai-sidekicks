// What the always-on diagnostic capture is allowed to hold.
//
// A bound TABLE beside its readers, for `perf-meters/perf-meter-bounds.ts`' reason:
// the cap gate reads DECLARATIONS, so a record whose keys are the bounds sits with
// the code that spends them. All four are spent in the capture next door and read
// nowhere else in the console.
//
// THESE ARE THE CAPS THE BLUEPRINT ASKS TO BE NAMED. Error capture is always on, in
// every build, on a machine that may be short of exactly the resource the records
// are describing — so the capture's own retention has to be a stated number rather
// than "until the forwarder catches up". Each bound below says what happens at its
// edge, and none of the three edges is silence: a dropped record is counted, a
// refused probe is counted and says so once through a record of its own, and an
// over-long detail is truncated with its own suffix.

/**
 * The retention bounds, by name. Closed — the table IS the declaration.
 *
 * `as const` so each figure is a literal type: a reader comparing against one cannot
 * be handed a widened `number`.
 */
export const DIAGNOSTIC_CAPTURE_BOUNDS = {
  /**
   * Records held pending before the oldest is dropped.
   *
   * 512 at the truncated detail length below is about 1 MB in the worst case — the
   * detail bound counts `String.length`, which is UTF-16 code units, so 512 × 1,024
   * characters is roughly 1,048,576 bytes and not the 524,000 a byte-per-character
   * reading gives. Affordable on a machine already in trouble, and roughly a minute of
   * a pathological failure loop. Past it the OLDEST goes, because a failure cascade's
   * first record is usually the cause and its five-hundredth is the same consequence
   * repeated — but the drop is counted and the count rides the next batch, so the
   * band is told what it did not receive.
   */
  pendingRecordCount: 512,

  /**
   * Records one batch carries to the diagnostic band.
   *
   * 32 rather than one-at-a-time because the forward crosses a process boundary and
   * a per-record crossing during a cascade is the cascade's own amplifier; 32 rather
   * than the whole pending buffer because a batch that could carry 512 records is a
   * roughly 1,048,576-byte message built at the moment memory is scarce — the same
   * 512 × 1,024 UTF-16 reading the pending bound above is stated in, and not the
   * 524,000 a byte-per-character reading gives.
   */
  batchRecordCount: 32,

  /**
   * Characters one record's detail is truncated to.
   *
   * A detail is a sentence about what broke. Anything past this is a payload that
   * was pasted into a message field — a stack of stacks, a serialized event — and
   * carrying it whole would let one record spend the whole pending buffer.
   */
  detailCharacterCount: 1024,

  /**
   * Distinct blind probes the capture remembers.
   *
   * The blind set is keyed by probe name and probe names are authored, not derived,
   * so 32 is far above the number that can exist. The bound is here because an
   * unbounded set in the module that reports memory pressure is the defect it exists
   * to find, and because a name arriving from a value rather than a literal is
   * exactly the bug this catches.
   */
  blindProbeCount: 32,
} as const;
