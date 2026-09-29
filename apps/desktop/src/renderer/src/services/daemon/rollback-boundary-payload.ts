// The rollback boundary's payload, decoded at the bridge.
//
// WHY IT LIVES HERE AND NOT BESIDE ITS CONSUMER. A contracts schema is a parser, and
// every parse of a wire value happens in `services/`: a feature that held its own
// schema would be a second reading of one shape, and the two would drift the moment
// the contract moved. The transcript's
// fixture projection consumes what this returns and never a schema of its own.
//
// WHY IT IS A READER AND NOT A RE-EXPORT. This module publishes this function, not
// `RunRolledBackEventSchema`: forwarding the schema would put the parser back in the
// code that consumes it, which is what this module exists to prevent.
//
// THE ARM'S REFINEMENT IS THE POINT. `RunRolledBackEventSchema` refines `position`
// against `payload.targetPosition`, so a rollback whose payload does not satisfy the
// contract has no trustworthy cutoff. The caller drops and counts such a row rather
// than drawing a band from a cutoff nobody can trust, which would hide real rows.

import { RunRolledBackEventSchema, type RunRolledBackEvent } from "@ai-sidekicks/contracts";

/**
 * Read a `run.rolled_back` payload, or `undefined` where the wire's is off contract.
 *
 * `undefined` rather than a throw or a partial value: the caller's answer to an
 * unreadable boundary is to drop the row and count it, and both of the other shapes
 * would make that a decision the caller could not take.
 */
export function readRollbackBoundaryPayload(payload: unknown): RunRolledBackEvent | undefined {
  const parsed = RunRolledBackEventSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}
