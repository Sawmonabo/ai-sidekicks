// The contract a projected timeline row has to satisfy, asked at the bridge.
//
// A console surface never holds a contracts schema — a schema is a parser, and
// `Spec-023 §Console Design (Meridian)` puts every parse at this boundary. That rule
// binds a test as hard as it binds production: a family test that imported
// `TimelineRowSchema` would be the second place the shape is read, and the second
// place is where the drift starts.
//
// It is a `.test-support` and not a production reader because nothing in production
// decodes a timeline row — the console PRODUCES them, and what a producer owes is
// that what it built satisfies the contract its consumers parse against. That is an
// assertion, so it lives with the assertions.

import { TimelineRowSchema } from "@ai-sidekicks/contracts";

/**
 * Whether one projected row satisfies the registered timeline-row contract.
 *
 * The real validator rather than a shape check written at a call site: a projection
 * that satisfied a local assertion and failed the contract would be one the daemon's
 * own consumers could never accept.
 */
export function isContractTimelineRow(row: unknown): boolean {
  return TimelineRowSchema.safeParse(row).success;
}
