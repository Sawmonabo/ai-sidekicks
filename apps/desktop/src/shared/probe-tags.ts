// The line prefixes the main process's smoke and GC probes print their readings
// under, and the test harnesses scan a spawned Electron's output for. One home for
// both sides: a harness scanning for a tag the probe no longer prints times out
// instead of reporting what went wrong. Each is uppercase and bracketed so it cannot
// collide with ordinary Electron or Chromium log output.

/** The stdout prefix of the smoke probe's single JSON reading. */
export const SMOKE_PROBE_TAG = "[SIDEKICKS_SMOKE_PROBE]";

/**
 * The stderr prefix of the smoke probe's readiness breadcrumbs.
 *
 * `did-finish-load` stays the ONLY signal the smoke test asserts on. These record
 * how far the boot got when the probe line never arrives, which turns one
 * indistinguishable timeout into several distinguishable ones. Kept off stdout so
 * the harness's probe-line scanner still sees exactly one tagged line there.
 */
export const READINESS_BREADCRUMB_TAG = "[SIDEKICKS_SMOKE_READY]";

/** The stdout prefix of the GC probe's single JSON reading. */
export const GC_PROBE_TAG = "[SIDEKICKS_GC_PROBE]";
