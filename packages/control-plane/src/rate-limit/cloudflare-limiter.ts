// The Workers relay's limiter. It names the Durable Object class as a type only, so this module
// loads on Node too, where the self-hosted relay builds its limiter and `cloudflare:workers` does
// not resolve.

import { RATE_LIMIT_ENDPOINT_GROUPS } from "./endpoint-groups.js";
import type { RateLimitIdentityDO } from "./identity-durable-object.js";
import type { RateLimitCheckRequest, RateLimitCheckResponse, RateLimiter } from "./limiter.js";

/** The Worker binding the limiter counts through: one Durable Object per source address. */
export interface RateLimitIdentityEnv {
  readonly RATE_LIMIT_IDENTITY: DurableObjectNamespace<RateLimitIdentityDO>;
}

// `idFromName` maps one address to one object worldwide, so every location meets the same count.
function getIdentityCounter(
  namespace: DurableObjectNamespace<RateLimitIdentityDO>,
  identity: string,
): DurableObjectStub<RateLimitIdentityDO> {
  return namespace.get(namespace.idFromName(identity));
}

/**
 * The Workers relay's `RateLimiter`: each check is one atomic check-and-consume in the Durable
 * Object of the request's source address. A failed round trip rejects `check`.
 */
export class CloudflareWorkersRateLimiter implements RateLimiter {
  readonly #env: RateLimitIdentityEnv;

  constructor(env: RateLimitIdentityEnv) {
    this.#env = env;
  }

  async check(request: RateLimitCheckRequest): Promise<RateLimitCheckResponse> {
    const { limit, periodSeconds } = RATE_LIMIT_ENDPOINT_GROUPS[request.endpoint];
    return getIdentityCounter(this.#env.RATE_LIMIT_IDENTITY, request.identity).checkAndConsume({
      group: request.endpoint,
      limit,
      windowSeconds: periodSeconds,
    });
  }
}
