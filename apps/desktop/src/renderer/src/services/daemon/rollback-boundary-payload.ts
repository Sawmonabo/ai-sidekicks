// The rollback boundary's payload, decoded at the bridge. Every parse of a wire value happens in
// `services/`, so the transcript's fixture projection consumes this reader and never holds a
// schema of its own, which would be a second reading of one shape. This publishes the function,
// not `RunRolledBackEventSchema`. The schema refines `position` against `payload.targetPosition`,
// so a payload that fails it has no trustworthy cutoff and the caller drops and counts the row.

import {
  RunRolledBackEventSchema,
  type RunRolledBackEvent,
} from "@ai-sidekicks/contracts/run-control";

/**
 * Read a `run.rolled_back` payload, or `undefined` where the wire's is off contract. Not a throw
 * or a partial value, since the caller's answer to an unreadable boundary is to drop and count
 * the row.
 */
export function readRollbackBoundaryPayload(payload: unknown): RunRolledBackEvent | undefined {
  const parsed = RunRolledBackEventSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}
