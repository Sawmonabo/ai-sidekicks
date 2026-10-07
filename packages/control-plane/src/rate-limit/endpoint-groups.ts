// Each counted group's limit, read by both counters and by the 429 they lead to, so the two relays
// cannot drift apart.

import type { RateLimitEndpointGroup } from "./limiter.js";

/** How many requests one source address may make in a sliding window of `periodSeconds`. */
export interface EndpointGroupLimit {
  readonly limit: number;
  readonly periodSeconds: number;
}

/** The limit of every endpoint group: the sign-in routes take 20 requests a minute per address. */
export const RATE_LIMIT_ENDPOINT_GROUPS: Readonly<
  Record<RateLimitEndpointGroup, EndpointGroupLimit>
> = {
  "auth.endpoint": { limit: 20, periodSeconds: 60 },
};
