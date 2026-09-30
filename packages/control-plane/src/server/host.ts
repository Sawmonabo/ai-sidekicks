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
//   - `buildControlPlaneFetchHandler(options)` — the test-friendly factory; every
//     test drives this function.
//   - `default { fetch }` — the deployable Worker module.
//
// No router is mounted yet: every procedure the control plane will serve lands
// on `router` below.

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { t, type SessionRouterContext } from "../sessions/trpc.js";
import { checkDevEnvironment, type DevEnvironmentEnv } from "./dev-environment-gate.js";
import { checkFeatureFlag, type FeatureFlagEnv } from "./feature-flag-gate.js";

/** The Worker environment both gates read. */
export type ControlPlaneEnv = FeatureFlagEnv & DevEnvironmentEnv;

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
  options: ControlPlaneHandlerOptions = {},
): (request: Request, env: ControlPlaneEnv) => Promise<Response> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const generateRequestId = options.requestIdGenerator ?? (() => crypto.randomUUID());
  const log = options.refusalLogger ?? ((message: string) => console.warn(message));

  // Built once at handler-construction time.
  const router = t.router({});

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

const productionFetchHandler = buildControlPlaneFetchHandler();

/** The deployable Worker module. */
export default {
  async fetch(request: Request, env: ControlPlaneEnv): Promise<Response> {
    return productionFetchHandler(request, env);
  },
};
