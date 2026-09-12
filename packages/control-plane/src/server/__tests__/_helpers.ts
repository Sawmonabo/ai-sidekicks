// Shared test fixtures for the host fetch-handler gate
// tests.
//
// The deps factories below are intentionally distinct in their failure
// behavior:
//
//   * `makeRefusalAssertingDeps()` — deps whose every method THROWS. The
//     gate-refusal contract says returns HTTP 503 BEFORE router dispatch;
//     if a refusal test ever reaches a stub method, the gate let traffic
//     through that should have been blocked. The throw turns a silent
//     contract violation into a loud test failure.
//
//   * `makePassThroughDeps(querier)` — deps that route through the REAL
//     `SessionDirectoryService` against a caller-supplied (typically
//     pglite-backed) `Querier`. Used and by the router happy-path
//     tests..T6.

import type { UserId, SessionId } from "@ai-sidekicks/contracts";
import { EventLogAnchorStore } from "../../event-anchors/anchor-store.js";
import { AttachService } from "../../runtime-nodes/attach-service.js";
import { HeartbeatService } from "../../runtime-nodes/heartbeat-service.js";
import type { Querier } from "../../sessions/migration-runner.js";
import { SessionDirectoryService } from "../../sessions/session-directory-service.js";
import type { SessionRouterDeps } from "../../sessions/session-router.js";
import type { ControlPlaneDeps } from "../host.js";

const REFUSAL_VIOLATION = (symbol: string): Error =>
  new Error(
    `gate-refusal contract violated: ${symbol} reached during a refusal test. ` +
      "must intercept before router dispatch.",
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
    // The runtime-node services hold the throwing querier but never touch it
    // at construction; they throw only on use, so a refusal test that
    // (incorrectly) reaches a runtime-node procedure fails loudly — same
    // contract as the throwing callbacks above.
    attachService: new AttachService(throwingQuerier),
    heartbeatService: new HeartbeatService(throwingQuerier),
    // Same posture as the runtime-node services above — the anchor store holds
    // the throwing querier and throws only on use, so a refusal test that
    // (incorrectly) reaches `eventanchor.upload` fails loudly.
    anchorStore: new EventLogAnchorStore(throwingQuerier),
    resolveCurrentUserId: () => {
      throw REFUSAL_VIOLATION("resolveCurrentUserId");
    },
    generateSessionId: () => {
      throw REFUSAL_VIOLATION("generateSessionId");
    },
    eventStreamProvider: () => {
      throw REFUSAL_VIOLATION("eventStreamProvider");
    },
  };
}

export interface PassThroughDepsConfig {
  readonly querier: Querier;
  readonly currentUserId: UserId;
  readonly nextSessionId: SessionId;
  readonly eventStreamProvider?: SessionRouterDeps["eventStreamProvider"];
}

export function makePassThroughDeps(config: PassThroughDepsConfig): ControlPlaneDeps {
  return {
    directoryService: new SessionDirectoryService(config.querier),
    // Real runtime-node services over the caller-supplied (pglite-backed)
    // Querier, parallel to `directoryService` above.
    attachService: new AttachService(config.querier),
    heartbeatService: new HeartbeatService(config.querier),
    // Real anchor store over the caller-supplied (pglite-backed) Querier,
    // parallel to `directoryService` above.
    anchorStore: new EventLogAnchorStore(config.querier),
    resolveCurrentUserId: () => config.currentUserId,
    generateSessionId: () => config.nextSessionId,
    // Default: no events. T7-T9 override with synthetic streams.
    eventStreamProvider:
      config.eventStreamProvider ??
      async function* () {
        // intentionally empty; gate tests do not subscribe
      },
  };
}
