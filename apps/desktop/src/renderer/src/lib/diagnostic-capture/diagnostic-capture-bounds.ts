// What the always-on diagnostic capture may hold, kept beside its reader
// (`diagnostic-capture.ts`) like the performance-meter bounds. Capture is on in every build, on
// a machine that may be short of the resource it reports on, so retention is a stated number.
// At each edge a dropped record is counted, a refused probe is counted and announced once by a
// record of its own, and an over-long detail is truncated with a suffix.
//
// The capture's own forward seam is excluded from the refused-probe edge: `flush` marks it blind
// whenever no forwarder is installed and `record` flushes at every batch, so counting it would
// measure how often the capture ran. Past a full set it is neither counted nor recorded; reaching
// that needs all thirty-two authored probe names blind first.

/** The retention bounds, by name. */
export const DIAGNOSTIC_CAPTURE_BOUNDS = {
  /**
   * Records held pending before the oldest is dropped.
   *
   * 512 records at the detail bound below is about 1 MB worst case (the bound counts UTF-16
   * code units, two bytes each). The oldest goes first, since a cascade's first record is
   * usually the cause; the drop is counted so the band is told what it did not receive.
   */
  pendingRecordCount: 512,

  /**
   * Records one batch carries to the diagnostic band.
   *
   * Not one at a time, because the forward crosses a process boundary and a crossing per record
   * would amplify a cascade; not the whole buffer, because a 512-record batch is a message of
   * about 1 MB built when memory is scarce.
   */
  batchRecordCount: 32,

  /**
   * Characters one record's detail is truncated to.
   *
   * A detail is a sentence about what broke; anything longer is a pasted payload that would
   * let one record spend the whole pending buffer.
   */
  detailCharacterCount: 1024,

  /**
   * Distinct blind probes the capture remembers.
   *
   * Probe names are authored, so 32 is far above the number that can exist; the bound catches a
   * name built from a value and keeps this module from growing without limit.
   */
  unreadableProbeCount: 32,
} as const;
