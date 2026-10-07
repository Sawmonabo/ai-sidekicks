// The self-hosted relay is one process, so it counts in that process's memory. Each source address
// gets one sliding window per endpoint group, and one timer drops each window once it has passed,
// so an address that never returns leaves nothing behind.

import { RATE_LIMIT_ENDPOINT_GROUPS } from "./endpoint-groups.js";
import type {
  RateLimitCheckRequest,
  RateLimitCheckResponse,
  RateLimitEndpointGroup,
  RateLimiter,
} from "./limiter.js";

function getWindowMilliseconds(endpoint: RateLimitEndpointGroup): number {
  return RATE_LIMIT_ENDPOINT_GROUPS[endpoint].periodSeconds * 1000;
}

/**
 * The self-hosted relay's sliding-window counter, held in its process's memory. It holds at most
 * one window per address counted within the last window, each at most `limit` request times, and
 * runs on Node only: its eviction timer is unref'd so it never keeps the relay's process alive.
 */
export class InMemoryRateLimiter implements RateLimiter {
  // Per endpoint group: address → its counted request times, oldest first. Each group's map is
  // ordered by newest counted request (a counted request moves its address to the back), and a
  // group shares one window length, so the addresses that expire first sit at the front.
  readonly #windowsByGroup = new Map<RateLimitEndpointGroup, Map<string, number[]>>();
  #isEvictionArmed = false;

  /**
   * How many source-address windows the counter holds now, across every endpoint group: the memory
   * bound, at most the addresses counted within the last window.
   */
  get heldWindowCount(): number {
    let count = 0;
    for (const groupWindows of this.#windowsByGroup.values()) count += groupWindows.size;
    return count;
  }

  async check(request: RateLimitCheckRequest): Promise<RateLimitCheckResponse> {
    const { limit } = RATE_LIMIT_ENDPOINT_GROUPS[request.endpoint];
    const windowMilliseconds = getWindowMilliseconds(request.endpoint);
    const now = Date.now();

    let groupWindows = this.#windowsByGroup.get(request.endpoint);
    if (groupWindows === undefined) {
      groupWindows = new Map();
      this.#windowsByGroup.set(request.endpoint, groupWindows);
    }
    const hits = groupWindows.get(request.identity) ?? [];
    const firstLiveHit = hits.findIndex((hit) => hit + windowMilliseconds > now);
    hits.splice(0, firstLiveHit === -1 ? hits.length : firstLiveHit);

    // An empty window starts with this request, so it is the oldest live one.
    const resetAt = new Date((hits[0] ?? now) + windowMilliseconds).toISOString();
    // A refused request is not recorded, so it never extends the window.
    if (hits.length >= limit) return { allowed: false, remaining: 0, resetAt, limit };

    hits.push(now);
    groupWindows.delete(request.identity);
    groupWindows.set(request.identity, hits);
    this.#armEviction(windowMilliseconds);
    return { allowed: true, remaining: limit - hits.length, resetAt, limit };
  }

  // A held timer is kept: while all endpoint groups share one window length, a new request never
  // expires before the held timer is due, so it fires early at worst and re-arms.
  #armEviction(delayMilliseconds: number): void {
    if (this.#isEvictionArmed) return;
    setTimeout(() => this.#evictExpiredWindows(), delayMilliseconds).unref();
    this.#isEvictionArmed = true;
  }

  // Drops every window whose newest counted request has aged out, then re-arms at the earliest
  // remaining expiry; with nothing left, no timer stays armed.
  #evictExpiredWindows(): void {
    this.#isEvictionArmed = false;
    const now = Date.now();
    let earliestExpiry: number | undefined;
    for (const [endpoint, groupWindows] of this.#windowsByGroup) {
      const windowMilliseconds = getWindowMilliseconds(endpoint);
      for (const [identity, hits] of groupWindows) {
        const newestHit = hits.at(-1);
        if (newestHit !== undefined && newestHit + windowMilliseconds > now) {
          earliestExpiry = Math.min(earliestExpiry ?? Infinity, newestHit + windowMilliseconds);
          break;
        }
        groupWindows.delete(identity);
      }
    }
    if (earliestExpiry !== undefined) this.#armEviction(earliestExpiry - now);
  }
}
