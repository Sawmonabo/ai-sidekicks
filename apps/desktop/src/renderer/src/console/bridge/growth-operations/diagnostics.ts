// The diagnostics plane's ledger rows: this machine's health, one run's failure
// detail and stall reading, the operator's recovery request, and the redaction
// policy read.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-port/growth-entry.js";
import { op } from "./operation-entry.js";

/**
 * The ids this plane carries, NAMED rather than matched by a `health${string}`
 * pattern.
 *
 * The `ledger.ts` shape and for that module's reason: the root is split across two
 * planes. `healthSubscribe` is the session plane's — it serves the `health-subscribe`
 * slate row, feeding the health strip and the park banner — and a pattern here would
 * silently claim it, which `index.test.ts` reports as two planes carrying one key.
 * The split is not an accident of naming either: the diagnostics section forbids this
 * page from consuming a health subscription at all, so the read plane and the stream
 * are different wires with different consumers that happen to share a root.
 */
type DiagnosticsOperationId = Extract<
  GrowthOperationId,
  | "healthStatusRead"
  | "healthFailureDetailRead"
  | "healthStuckRunInspect"
  | "healthRecoveryActionRequest"
  | "healthRedactionPolicyRead"
>;

/** The diagnostics rows, in the registered method registry's own order. */
export const DIAGNOSTICS_GROWTH_OPERATIONS: Readonly<
  Record<DiagnosticsOperationId, GrowthOperationEntry>
> = {
  // The one-shot status read serves `health-status-read` and not this plane's own
  // row: that row IS this wire, and the console has two surfaces waiting on it — the
  // session header's compact form and this page's banner. A wire named by two rows would be
  // two records of one absence, so the row keyed on the wire carries both consumers
  // and the row beside it carries the four reads that have no row of their own.
  healthStatusRead: op("healthStatusRead", "health-status-read", "method", "health.statusRead"),
  healthFailureDetailRead: op(
    "healthFailureDetailRead",
    "health-diagnostics-reads",
    "method",
    "health.failureDetailRead",
  ),
  healthStuckRunInspect: op(
    "healthStuckRunInspect",
    "health-diagnostics-reads",
    "method",
    "health.stuckRunInspect",
  ),
  healthRecoveryActionRequest: op(
    "healthRecoveryActionRequest",
    "health-diagnostics-reads",
    "method",
    "health.recoveryActionRequest",
  ),
  healthRedactionPolicyRead: op(
    "healthRedactionPolicyRead",
    "health-diagnostics-reads",
    "method",
    "health.redactionPolicyRead",
  ),
};
