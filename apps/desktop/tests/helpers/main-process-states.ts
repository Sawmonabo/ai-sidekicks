// The supervisor states the main-process suites drive over.

import type { DaemonConnection } from "@shared/daemon-status-topic.js";

/**
 * Every arm a supervisor actually reports, `unreported` excluded.
 *
 * The absence is the point: `unreported` is what a window holds before anything has
 * said, and a suite quantifying over it beside the reported arms would be asserting
 * that silence means something.
 */
export const REPORTED_CONNECTIONS: readonly DaemonConnection[] = [
  { kind: "probing" },
  { kind: "starting" },
  { kind: "connected" },
  { kind: "reconnecting", attempt: 2, attemptLimit: 5 },
  { kind: "version-incompatible" },
  { kind: "offline", attemptLimit: 5, lastError: "spawn ENOENT" },
  { kind: "stopped" },
];
