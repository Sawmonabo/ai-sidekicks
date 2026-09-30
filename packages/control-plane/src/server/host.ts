// The control plane's Worker entry, served through tRPC's fetch adapter.
// Two gates run at request entry, before any router dispatch: CONTROL_PLANE_BOOTSTRAP_ENABLED must
// be '1' and ENVIRONMENT must be 'development'. A refusal returns 503 and logs its reason so an
// operator can diagnose a misconfigured dev instance. The router mounts no procedures yet.

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
   * Request-id generator; defaults to `crypto.randomUUID()`. Tests inject a deterministic one.
   */
  readonly requestIdGenerator?: () => string;
  /**
   * Refusal logger; defaults to `console.warn`. Tests inject a capturing sink.
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

  // Built once per handler, not per request.
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
