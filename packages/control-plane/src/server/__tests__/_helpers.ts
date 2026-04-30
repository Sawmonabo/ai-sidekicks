// Shared test fixtures for the host fetch-handler gate tests
// (Plan-008 §Phase 1 §T-008b-1-T1..T3 + §T-008b-1-T4..T6).
//
// The deps factories below are intentionally distinct in their failure
// behavior:
//
//   * `makeRefusalAssertingDeps()` — deps whose every method THROWS. The
//     gate-refusal contract says I-008-1 returns HTTP 503 BEFORE router
//     dispatch; if a refusal test ever reaches a stub method, the gate let
//     traffic through that should have been blocked. The throw turns a
//     silent contract violation into a loud test failure.
//
//   * `makePassThroughDeps(querier)` — deps that route through the REAL
//     `SessionDirectoryService` against a caller-supplied (typically
//     pglite-backed) `Querier`. Used by T-008b-1-T3 (gate-pass smoke) and
//     by the router happy-path tests T-008b-1-T4..T6.

import type { ParticipantId, SessionId } from "@ai-sidekicks/contracts";
import type { Querier } from "../../sessions/migration-runner.js";
import { SessionDirectoryService } from "../../sessions/session-directory-service.js";
import type { SessionRouterDeps } from "../../sessions/session-router.js";
import type { ControlPlaneDeps } from "../host.js";

const REFUSAL_VIOLATION = (symbol: string): Error =>
  new Error(
    `gate-refusal contract violated: ${symbol} reached during a refusal test. ` +
      "I-008-1 must intercept before router dispatch.",
  );

export function makeRefusalAssertingDeps(): ControlPlaneDeps {
  const throwingQuerier: Querier = {
    query: () => {
      throw REFUSAL_VIOLATION("Querier.query");
    },
    exec: () => {
      throw REFUSAL_VIOLATION("Querier.exec");
    },
    transaction: () => {
      throw REFUSAL_VIOLATION("Querier.transaction");
    },
  };
  return {
    directoryService: new SessionDirectoryService(throwingQuerier),
    resolveCurrentParticipantId: () => {
      throw REFUSAL_VIOLATION("resolveCurrentParticipantId");
    },
    generateSessionId: () => {
      throw REFUSAL_VIOLATION("generateSessionId");
    },
    resolveIdentityHandle: () => {
      throw REFUSAL_VIOLATION("resolveIdentityHandle");
    },
    eventStreamProvider: () => {
      throw REFUSAL_VIOLATION("eventStreamProvider");
    },
  };
}

export interface PassThroughDepsConfig {
  readonly querier: Querier;
  readonly currentParticipantId: ParticipantId;
  readonly nextSessionId: SessionId;
  readonly identityResolver?: SessionRouterDeps["resolveIdentityHandle"];
  readonly eventStreamProvider?: SessionRouterDeps["eventStreamProvider"];
}

export function makePassThroughDeps(config: PassThroughDepsConfig): ControlPlaneDeps {
  return {
    directoryService: new SessionDirectoryService(config.querier),
    resolveCurrentParticipantId: () => config.currentParticipantId,
    generateSessionId: () => config.nextSessionId,
    // Default Tier-1 self-resolver: identityHandle is the wire-encoded
    // ParticipantId. Tests can override to model unauthenticated cases.
    resolveIdentityHandle: config.identityResolver ?? ((handle) => handle as ParticipantId),
    // Default: no events. T7-T9 override with synthetic streams.
    eventStreamProvider:
      config.eventStreamProvider ??
      async function* () {
        // intentionally empty; gate tests do not subscribe
      },
  };
}
