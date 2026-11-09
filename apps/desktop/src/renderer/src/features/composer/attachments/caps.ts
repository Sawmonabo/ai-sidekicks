// The upload's stall threshold.

/**
 * Silence after which an in-flight upload says it has gone quiet. The console's own, with no
 * wire source: long enough that a slow-uplink round trip is not a stall, short enough that there
 * is still time to act.
 */
export const INGEST_STALL_DISCLOSURE_MS = 60_000;
