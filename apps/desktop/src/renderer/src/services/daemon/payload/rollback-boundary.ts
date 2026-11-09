// The rollback boundary's payload, decoded at the bridge. Every check of a wire value happens in
// `services/`, so the transcript's fixture projection consumes this reader and never runs a check
// of its own, which would be a second reading of one shape. A payload that fails the check has no
// trustworthy `targetPosition`, so the caller drops and counts the row.

import {
  validateAgentRunRolledBackEvent,
  type AgentRunRolledBackEvent,
} from "@ai-sidekicks/contracts/run/control";

/**
 * Read an `agent.run.rolledBack` payload, or `undefined` where the wire's is off contract. Not a
 * throw or a partial value, since the caller's answer to an unreadable boundary is to drop and
 * count the row.
 */
export function readRollbackBoundaryPayload(payload: unknown): AgentRunRolledBackEvent | undefined {
  return validateAgentRunRolledBackEvent(payload) ? payload : undefined;
}
