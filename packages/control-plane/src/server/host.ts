// Deployed as a Cloudflare Worker via `@trpc/server/adapters/fetch`'s
// `fetchRequestHandler`.
//
// Dual-gate enforcement runs at request entry:
//   1. CONTROL_PLANE_BOOTSTRAP_ENABLED === '1'  (kill-switch; default off)
//   2. ENVIRONMENT === 'development'            (allow-list; only one passing value)
// Both refusals return HTTP 503 immediately, before any router dispatch. Logging
// the refusal reason is intentional — operator-facing diagnostic for misconfigured
// dev instances.
//
// This module exposes TWO surfaces:
//   - `buildControlPlaneFetchHandler(deps)` — the test-friendly factory. Accepts
//     the anchor store by constructor injection; every test drives this function.
//   - `default { fetch }` — the deployable Worker module. The production Querier
//     (a Hyperdrive-backed adapter) is not wired yet, so the deployable surface
//     throws on Querier use. The dual gate intercepts before that throw is
//     reachable in normal flows; the throw is defense-in-depth for any
//     hypothetical gate bypass.
//

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { EventLogAnchorStore } from "../event-anchors/anchor-store.js";
import {
  createEventAnchorRouter,
  type EventAnchorRouterDeps,
} from "../event-anchors/anchor-router.js";
import type { Querier } from "../sessions/migration-runner.js";
import type { SessionRouterContext } from "../sessions/trpc.js";
import { checkDevEnvironment, type DevEnvironmentEnv } from "./dev-environment-gate.js";
import { checkFeatureFlag, type FeatureFlagEnv } from "./feature-flag-gate.js";

/** The Worker environment both gates read. */
export type ControlPlaneEnv = FeatureFlagEnv & DevEnvironmentEnv;

/** Host deps: what the mounted routers close over. Tests inject a PGlite-backed anchor store. */
export type ControlPlaneDeps = EventAnchorRouterDeps;

/** Optional overrides for {@link buildControlPlaneFetchHandler}. */
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
   * to assert the refusal-logging contract.
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

/**
 * Builds the gated fetch handler: both gates run first and refuse with a 503,
 * then the request dispatches into the tRPC router.
 */
export function buildControlPlaneFetchHandler(
  deps: ControlPlaneDeps,
  options: ControlPlaneHandlerOptions = {},
): (request: Request, env: ControlPlaneEnv) => Promise<Response> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const generateRequestId = options.requestIdGenerator ?? (() => crypto.randomUUID());
  const log = options.refusalLogger ?? ((message: string) => console.warn(message));

  // Built once at handler-construction time; the procedure closes over the
  // constructor-injected anchor store.
  const router = createEventAnchorRouter(deps);

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

// The production Querier (Hyperdrive binding → Querier adapter) is not wired
// yet, so the deployable surface composes through `buildControlPlaneFetchHandler`
// with an anchor store over a throwing Querier:
//   - Gate-fail requests (any production deploy without .dev.vars) → 503 (gate refusal).
//   - Gate-pass requests (only `wrangler dev` with both .dev.vars keys) → 500
//     from the procedure body's throw, until the real Querier is wired.
// Tests bypass this default export and call `buildControlPlaneFetchHandler`
// directly with a PGlite-backed `Querier`.

function deferredWiringError(symbol: string): Error {
  return new Error(
    `${symbol} wiring is deferred; this build is operator-development-only ` +
      "behind the dual gate.",
  );
}

const productionPlaceholderQuerier: Querier = {
  query() {
    throw deferredWiringError("Querier.query (Hyperdrive binding pending)");
  },
  exec() {
    throw deferredWiringError("Querier.exec (Hyperdrive binding pending)");
  },
  transaction() {
    throw deferredWiringError("Querier.transaction (Hyperdrive binding pending)");
  },
};

// `EventLogAnchorStore` carries a private `#querier` field, so TypeScript treats
// it nominally: construct the real class with the throwing querier rather than
// casting a structural stub, which would mask future drift on the class.
const productionFetchHandler = buildControlPlaneFetchHandler({
  anchorStore: new EventLogAnchorStore(productionPlaceholderQuerier),
});

/** The deployable Worker module. */
export default {
  async fetch(request: Request, env: ControlPlaneEnv): Promise<Response> {
    return productionFetchHandler(request, env);
  },
};
