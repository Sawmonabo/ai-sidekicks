// Plan-008 §Phase 1 §T-008b-1-1: tRPC v11 host scaffolding for the
// control-plane bootstrap, deployed as a Cloudflare Worker via
// `@trpc/server/adapters/fetch`'s `fetchRequestHandler` (per BL-104 resolution).
//
// I-008-1 dual-gate enforcement runs at request entry:
//   1. CONTROL_PLANE_BOOTSTRAP_ENABLED === '1'  (kill-switch; default off)
//   2. ENVIRONMENT === 'development'            (allow-list; only one passing value)
// Both refusals return HTTP 503 immediately, before any router dispatch. Logging
// the refusal reason is intentional — operator-facing diagnostic for misconfigured
// dev instances.
//
// This module exposes TWO surfaces:
//   - `buildControlPlaneFetchHandler(deps)` — the test-friendly factory. Accepts
//     a directoryService (constructor injection per I-008-3 #1). All Phase 1 tests
//     drive this function.
//   - `default { fetch }` — the deployable Worker module. Production wiring of
//     SessionDirectoryService (Hyperdrive / D1 / WorkerPg adapter) is deferred
//     to Tier 5 per I-008-2; the deployable surface throws on Querier construction.
//     The dual-gate intercepts before that throw is reachable in normal flows;
//     the throw is defense-in-depth for any hypothetical gate bypass.
//
// Refs: docs/plans/008-control-plane-relay-and-session-join.md §I-008-1, §I-008-2,
//       §I-008-3 #1, §T-008b-1-1, ADR-014, BL-104.

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { Querier } from "../sessions/migration-runner.js";
import { SessionDirectoryService } from "../sessions/session-directory-service.js";
import { createSessionRouter } from "../sessions/session-router.factory.js";
import type { SessionRouterDeps } from "../sessions/session-router.js";
import type { SessionRouterContext } from "../sessions/trpc.js";
import { checkDevEnvironment, type DevEnvironmentEnv } from "./dev-environment-gate.js";
import { checkFeatureFlag, type FeatureFlagEnv } from "./feature-flag-gate.js";

export type ControlPlaneEnv = FeatureFlagEnv & DevEnvironmentEnv;

/**
 * Tier 1 host deps — same shape as the router's `SessionRouterDeps` (the host
 * just forwards). Tests inject a pglite-backed directoryService + deterministic
 * stubs for the principal/ID/identity callbacks.
 */
export type ControlPlaneDeps = SessionRouterDeps;

export interface ControlPlaneHandlerOptions {
  /** tRPC endpoint base path. Defaults to `/trpc`. */
  readonly endpoint?: string;
  /**
   * Request-id generator — defaults to `crypto.randomUUID()`. Tests inject
   * a deterministic generator to assert on request-correlation logging.
   */
  readonly requestIdGenerator?: () => string;
  /**
   * Refusal logger — defaults to `console.warn`. Tests inject a capture sink
   * to assert the refusal-logging contract from §T-008b-1-T1.
   */
  readonly refusalLogger?: (message: string) => void;
}

const DEFAULT_ENDPOINT = "/trpc";

function refuseUnavailable(reason: string, log: (message: string) => void): Response {
  log(`control-plane refused: ${reason}`);
  return new Response("Service Unavailable", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export function buildControlPlaneFetchHandler(
  deps: ControlPlaneDeps,
  options: ControlPlaneHandlerOptions = {},
): (request: Request, env: ControlPlaneEnv) => Promise<Response> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const generateRequestId = options.requestIdGenerator ?? (() => crypto.randomUUID());
  const log = options.refusalLogger ?? ((message: string) => console.warn(message));

  // Build the router once at handler-construction time. Each procedure closes
  // over `deps.directoryService` per I-008-3 #1 — this is the only constructor
  // injection surface for the directory dependency.
  const router = createSessionRouter(deps);

  return async function handle(request, env) {
    const flagResult = checkFeatureFlag(env);
    if (!flagResult.ok) return refuseUnavailable(flagResult.reason, log);

    const envResult = checkDevEnvironment(env);
    if (!envResult.ok) return refuseUnavailable(envResult.reason, log);

    return fetchRequestHandler({
      endpoint,
      req: request,
      router,
      createContext: (): SessionRouterContext => ({
        requestId: generateRequestId(),
      }),
    });
  };
}

// Production Worker entrypoint. The directoryService production wiring
// (Hyperdrive binding → Querier adapter) is deferred to Plan-008-remainder
// at Tier 5 per §I-008-2. At Tier 1, the deployable surface composes through
// `buildControlPlaneFetchHandler` with a placeholder directoryService whose
// methods throw — meaning:
//   - Gate-fail requests (any production deploy without .dev.vars) → 503 (gate refusal).
//   - Gate-pass requests (only `wrangler dev` with both .dev.vars keys) → 500
//     from the procedure body's throw. This is acceptable for Phase 1's skeleton
//     scope: Tier 5 wires the real Querier and procedures stop throwing.
// Tests bypass this default export and call `buildControlPlaneFetchHandler`
// directly with a pglite-backed `Querier` so they can exercise the happy path.

function tier5DeferralError(symbol: string): Error {
  return new Error(
    `Plan-008 Tier 1: ${symbol} wiring is deferred to Tier 5; Phase 1 is ` +
      "operator-development-only behind I-008-1 dual-gate. See " +
      "docs/plans/008-control-plane-relay-and-session-join.md §I-008-2.",
  );
}

// `SessionDirectoryService` is a class with a private `#querier` field, so
// TypeScript treats it nominally — a structural-shape literal can't satisfy
// the type without an `as unknown as` double-cast. Instead of casting (which
// would silently mask any future surface drift on the class), construct the
// real class with a throwing `Querier` adapter. Production wiring at Tier 5
// (per §I-008-2) replaces this adapter with a Hyperdrive-backed Pool; until
// then the gates intercept any traffic before this querier is reached.
const productionPlaceholderQuerier: Querier = {
  query() {
    throw tier5DeferralError("Querier.query (Hyperdrive binding pending)");
  },
  exec() {
    throw tier5DeferralError("Querier.exec (Hyperdrive binding pending)");
  },
  transaction() {
    throw tier5DeferralError("Querier.transaction (Hyperdrive binding pending)");
  },
};

const productionPlaceholderDirectoryService = new SessionDirectoryService(
  productionPlaceholderQuerier,
);

const productionFetchHandler = buildControlPlaneFetchHandler({
  directoryService: productionPlaceholderDirectoryService,
  resolveCurrentParticipantId: () => {
    throw tier5DeferralError("resolveCurrentParticipantId (PASETO auth)");
  },
  generateSessionId: () => {
    throw tier5DeferralError("generateSessionId (UUID v7)");
  },
  resolveIdentityHandle: () => {
    throw tier5DeferralError("resolveIdentityHandle (Plan-018 + Plan-002)");
  },
  eventStreamProvider: () => {
    throw tier5DeferralError("eventStreamProvider (Plan-006 event log)");
  },
});

export default {
  async fetch(request: Request, env: ControlPlaneEnv): Promise<Response> {
    return productionFetchHandler(request, env);
  },
};
