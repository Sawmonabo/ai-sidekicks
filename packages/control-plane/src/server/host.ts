// The control plane's Worker entry, served through tRPC's fetch adapter.
// Two gates run at request entry, before any router dispatch: CONTROL_PLANE_BOOTSTRAP_ENABLED must
// be '1' and ENVIRONMENT must be 'development'. A refusal returns 503 and logs its reason, so a
// misconfigured dev instance names the variable it lacks. The router mounts no procedures.

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { RateLimitIdentityEnv } from "../rate-limit/cloudflare-limiter.js";
import { createAdmissionCheck } from "../rate-limit/enforcement-pipeline.js";
import { createRateLimiterFactory } from "../rate-limit/factory.js";
import { t, type ControlPlaneContext } from "./trpc.js";
import { checkDevEnvironment, type DevEnvironmentEnv } from "./dev-environment-gate.js";
import { checkFeatureFlag, type FeatureFlagEnv } from "./feature-flag-gate.js";

// Cloudflare requires a Durable Object class exported from the Worker's main module.
export { RateLimitIdentityDO } from "../rate-limit/identity-durable-object.js";

/** The Worker environment: what both gates read, and the sign-in routes' counter binding. */
export type ControlPlaneEnv = FeatureFlagEnv & DevEnvironmentEnv & RateLimitIdentityEnv;

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

// Cloudflare sets it to the address the request reached its edge from; a caller cannot set it.
const CLIENT_ADDRESS_HEADER = "CF-Connecting-IP";

function refuseUnavailable(reason: string, log: (message: string) => void): Response {
  log(`control-plane refused: ${reason}`);
  return new Response("Service Unavailable", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * Builds one request's context on the Workers relay: the caller's address as Cloudflare reports it,
 * the response headers the adapter sends, and the admission check over the address's Durable Object.
 */
export function createControlPlaneContext(options: {
  readonly request: Request;
  readonly responseHeaders: Headers;
  readonly env: RateLimitIdentityEnv;
  readonly requestId: string;
}): ControlPlaneContext {
  return {
    requestId: options.requestId,
    sourceAddress: options.request.headers.get(CLIENT_ADDRESS_HEADER) ?? undefined,
    responseHeaders: options.responseHeaders,
    checkAdmission: createAdmissionCheck({
      limiterFor: createRateLimiterFactory({ kind: "workers", env: options.env }).forEndpoint,
    }),
  };
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
      createContext: ({ resHeaders }) =>
        createControlPlaneContext({
          request,
          responseHeaders: resHeaders,
          env,
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
