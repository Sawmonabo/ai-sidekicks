// The Worker's bindings from `wrangler.toml`, as `env` from `cloudflare:workers` hands them to the
// tests that run inside workerd. The production build leaves `__tests__/` out, so no Worker code
// reads `env` this way.

import type { RateLimitIdentityEnv } from "../rate-limit/cloudflare-limiter.js";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly RATE_LIMIT_IDENTITY: RateLimitIdentityEnv["RATE_LIMIT_IDENTITY"];
    }
  }
}
