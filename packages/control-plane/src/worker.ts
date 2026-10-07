// The deployed Worker's entry module, the one `wrangler.toml` names as `main`. Cloudflare reads each
// Durable Object class from this module's exports, and only this module's imports reach the Workers
// runtime, so the fetch handler and the package entry stay loadable on Node.

import { buildControlPlaneFetchHandler, type ControlPlaneEnv } from "./server/host.js";

export { RateLimitIdentityDurableObject } from "./rate-limit/identity-durable-object.js";

const productionFetchHandler = buildControlPlaneFetchHandler();

/** The deployable Worker module. */
export default {
  async fetch(request: Request, env: ControlPlaneEnv): Promise<Response> {
    return productionFetchHandler(request, env);
  },
};
