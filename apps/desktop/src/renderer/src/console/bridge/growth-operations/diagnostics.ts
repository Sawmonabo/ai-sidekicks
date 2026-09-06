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
  healthStatusRead: op(
    "healthStatusRead",
    "health-diagnostics-reads",
    "method",
    "read this machine's execution health — one verdict over its named components, each carrying its own reading — over the daemon JSON-RPC transport",
    "health.statusRead",
  ),
  healthFailureDetailRead: op(
    "healthFailureDetailRead",
    "health-diagnostics-reads",
    "method",
    "read one run's classified failure detail, so a provider that refused and a worktree that vanished do not read the same",
    "health.failureDetailRead",
  ),
  healthStuckRunInspect: op(
    "healthStuckRunInspect",
    "health-diagnostics-reads",
    "method",
    "read one run's stall reading — when it last progressed, what is blocking it, and the daemon's own suggestion",
    "health.stuckRunInspect",
  ),
  healthRecoveryActionRequest: op(
    "healthRecoveryActionRequest",
    "health-diagnostics-reads",
    "method",
    "ask the daemon to retry, interrupt, or abandon one stuck run, and answer with the states it moved between",
    "health.recoveryActionRequest",
  ),
  healthRedactionPolicyRead: op(
    "healthRedactionPolicyRead",
    "health-diagnostics-reads",
    "method",
    "read the diagnostic redaction policy in force — the per-bucket retention, the outbound default, and whether an override is active",
    "health.redactionPolicyRead",
  ),
};
