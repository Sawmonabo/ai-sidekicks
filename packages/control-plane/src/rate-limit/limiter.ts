// The one counter contract both relays implement: the Workers relay counts in a Durable Object per
// source address, the self-hosted relay in its process's memory. Only the relay checks a limit.

/** The key of each counted group of routes; the sign-in routes are the only group. */
export type RateLimitEndpointGroup = "auth.endpoint";

/** One request to count: who sent it and which group of routes it reached. */
export interface RateLimitCheckRequest {
  /** The caller's source address in canonical form: an IPv4 address, or an IPv6 /64 prefix. */
  readonly identity: string;
  readonly endpoint: RateLimitEndpointGroup;
}

/** The window's state after one check; `resetAt` is an ISO 8601 instant. */
export interface RateLimitCheckResponse {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: string;
  readonly limit: number;
}

/**
 * A sliding-window counter. Each `check` counts the request when the window has room and refuses it
 * otherwise; a counter failure rejects, and the caller fails that one request.
 */
export interface RateLimiter {
  check(request: RateLimitCheckRequest): Promise<RateLimitCheckResponse>;
}
