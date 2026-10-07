// Picks the counter from the deployment alone: the Workers relay counts in its Durable Objects, the
// self-hosted relay in its own memory. Neither reads the process environment.

import { CloudflareWorkersRateLimiter, type RateLimitIdentityEnv } from "./cloudflare-limiter.js";
import { InMemoryRateLimiter } from "./in-memory-limiter.js";
import type { RateLimitEndpointGroup, RateLimiter } from "./limiter.js";

/**
 * The relay deployment that counts: the Workers relay through its injected Durable Object binding,
 * or the self-hosted relay on Node.
 */
export type RateLimiterDeployment =
  | { readonly kind: "workers"; readonly env: RateLimitIdentityEnv }
  | { readonly kind: "node" };

/** Hands out the counter for an endpoint group; `forEndpoint` may be called unbound. */
export interface RateLimiterFactory {
  readonly forEndpoint: (endpoint: RateLimitEndpointGroup) => RateLimiter;
}

/**
 * Builds the deployment's factory. It holds one counter for its lifetime and returns it for every
 * group, since each check names its own group; a self-hosted relay builds one factory at startup.
 */
export function createRateLimiterFactory(deployment: RateLimiterDeployment): RateLimiterFactory {
  const limiter =
    deployment.kind === "workers"
      ? new CloudflareWorkersRateLimiter(deployment.env)
      : new InMemoryRateLimiter();
  return { forEndpoint: () => limiter };
}
