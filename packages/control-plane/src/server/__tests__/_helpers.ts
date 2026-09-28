// Shared test fixtures for the host fetch-handler tests.
//
// The deps factories below are intentionally distinct in their failure
// behavior:
//
//   * `makeRefusalAssertingDeps()` — deps whose every method THROWS. The
//     gate-refusal contract returns HTTP 503 BEFORE router dispatch; if a
//     refusal test ever reaches a stub method, the gate let traffic through
//     that should have been blocked. The throw turns a silent contract
//     violation into a loud test failure.
//
//   * `makePassThroughDeps(querier)` — deps that route through the REAL
//     `EventLogAnchorStore` against a caller-supplied (typically
//     PGlite-backed) `Querier`, for the router happy-path tests.

import { EventLogAnchorStore } from "../../event-anchors/anchor-store.js";
import type { Querier } from "../../sessions/migration-runner.js";
import type { ControlPlaneDeps } from "../host.js";

const REFUSAL_VIOLATION = (symbol: string): Error =>
  new Error(
    `gate-refusal contract violated: ${symbol} reached during a refusal test. ` +
      "must intercept before router dispatch.",
  );

/** Deps whose querier throws on any use, so a refusal test reaching a procedure fails loudly. */
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
  // The anchor store holds the throwing querier and throws only on use.
  return { anchorStore: new EventLogAnchorStore(throwingQuerier) };
}

/** Deps backed by the real anchor store over the caller's querier. */
export function makePassThroughDeps(querier: Querier): ControlPlaneDeps {
  return { anchorStore: new EventLogAnchorStore(querier) };
}
