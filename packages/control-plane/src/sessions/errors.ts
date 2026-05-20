// Control-plane session domain exceptions.
//
// Mirrors the daemon-side pattern at
// `packages/runtime-daemon/src/ipc/session-errors.ts:35`: a typed Error
// subclass whose stable `readonly code` literal projects directly into the
// transport-layer envelope (here, the tRPC `errorFormatter` at
// `trpc.ts` lifts it onto `shape.data.aisError`).
//
// Plan-001 PR ships the first instance — `ResourceLimitExceededException`
// for AC8 (participants-per-session) enforcement. Future plans add more
// typed exceptions (Plan-002+ version-floor / version-ceiling envelopes
// when they ship emit sites against the Plan-001 T2.3 contracts) by
// declaring a new `extends Error` class with its own `readonly code`
// literal. If 3+ typed exceptions accumulate, refactor into an
// `AisWireException` base class so the formatter matches a single
// `instanceof` branch.
//
// Throw discipline: throw from inside the `Querier.transaction(...)`
// callback OR from the service body. The `pg.Pool` adapter at
// `session-directory-service.ts:782` auto-runs `ROLLBACK` and re-raises;
// the PGlite adapter has equivalent semantics. The transport layer
// (`session-router.factory.ts`) catches the typed throw and rethrows
// as a `TRPCError` with the appropriate HTTP-equivalent code (e.g.
// `TOO_MANY_REQUESTS` for resource-limit_exceeded per HTTP 429
// convention).

import type { ResourceLimitExceededDetails } from "@ai-sidekicks/contracts";
import { RESOURCE_LIMIT_EXCEEDED_CODE } from "@ai-sidekicks/contracts";

/**
 * Thrown by `SessionDirectoryService.joinSession` when the session has
 * reached its configured participant-limit cap. Carries the canonical
 * Spec-001 §Limit Enforcement payload shape verbatim so the transport
 * layer can project the typed cause onto `data.aisError` without any
 * field-level translation.
 *
 * `details.resource` is "participants per session" per Spec-001 §Resource
 * Limits row 1 — the wire-stable identifier the SDK retry/backoff logic
 * branches on (Plan-005 downstream).
 *
 * `details.limit` is the configured cap (Tier 1: hard-coded default of
 * 10 per Spec-001 §Resource Limits; per-session override via session
 * config is post-V1 scope).
 *
 * `details.current` is the count observed at the moment of rejection
 * (always equals or exceeds `limit` at throw time per the precheck
 * ordering in `joinSession`).
 */
export class ResourceLimitExceededException extends Error {
  readonly code: typeof RESOURCE_LIMIT_EXCEEDED_CODE = RESOURCE_LIMIT_EXCEEDED_CODE;
  readonly details: ResourceLimitExceededDetails;

  constructor(details: ResourceLimitExceededDetails, message: string) {
    super(message);
    this.name = "ResourceLimitExceededException";
    this.details = details;
  }
}
