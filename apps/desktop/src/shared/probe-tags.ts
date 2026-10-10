// What the smoke and GC probes share with the test harnesses that spawn them: the line prefixes the
// probes print their readings under, which the harnesses scan a spawned Electron's output for, and
// what the smoke harness hands its probe. Each prefix is uppercase and bracketed so it cannot
// collide with ordinary Electron or Chromium log output.

/** The stdout prefix of the smoke probe's single JSON reading. */
export const SMOKE_PROBE_TAG = "[SIDEKICKS_SMOKE_PROBE]";

/**
 * The stderr prefix of the smoke probe's readiness breadcrumbs, which record how far the boot
 * got when the probe line never arrives. Kept off stdout so the harness sees exactly one
 * tagged line there.
 */
export const READINESS_BREADCRUMB_TAG = "[SIDEKICKS_SMOKE_READY]";

/** The stdout prefix of the GC probe's single JSON reading. */
export const GC_PROBE_TAG = "[SIDEKICKS_GC_PROBE]";

/**
 * The environment variable the smoke harness names the renderer's worker script in, as a path
 * under the served bundle's root, for the probe to start it there.
 */
export const SMOKE_WORKER_SCRIPT_ENV = "SIDEKICKS_SMOKE_WORKER_SCRIPT";
