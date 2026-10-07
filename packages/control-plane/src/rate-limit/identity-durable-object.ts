// The Workers relay's counter: one Durable Object per source address, so an address meets one count
// whichever location serves it. Each counted group stores the times of its in-window hits and its
// window length, so the alarm can prune a group without the endpoint-group registry.

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { RateLimitCheckResponse, RateLimitEndpointGroup } from "./limiter.js";

/** One count against a group's window: its limit, and the window's length in seconds. */
interface CheckAndConsumeRequest {
  readonly group: RateLimitEndpointGroup;
  readonly limit: number;
  readonly windowSeconds: number;
}

// A group as stored under its own key: hits in milliseconds since the epoch, never empty.
const groupWindowSchema = z.strictObject({
  windowMilliseconds: z.number().int().positive(),
  hits: z.array(z.number().int().nonnegative()).min(1),
});

type GroupWindow = z.infer<typeof groupWindowSchema>;

interface StoredWindows {
  readonly windows: Map<string, GroupWindow>;
  // Each group whose stored value does not parse, with zod's account of why.
  readonly unreadable: ReadonlyMap<string, string>;
}

// A message of its own, since a ZodError reaches the RPC caller as its name alone.
function describeUnreadable(unreadable: ReadonlyMap<string, string>): string {
  return Array.from(
    unreadable,
    ([group, problem]) => `stored rate-limit window "${group}" does not parse: ${problem}`,
  ).join("; ");
}

// A hit counts while it is younger than one window.
function liveHits(hits: readonly number[], windowMilliseconds: number, now: number): number[] {
  return hits.filter((hit) => hit + windowMilliseconds > now);
}

// A group's window frees entirely one window after its newest hit.
function earliestExpiry(windows: Iterable<GroupWindow>): number {
  return Math.min(
    ...Array.from(windows, (window) => Math.max(...window.hits) + window.windowMilliseconds),
  );
}

// The window frees its next slot when its oldest live hit ages out.
function resetAtOf(hits: readonly number[], windowMilliseconds: number): string {
  return new Date(Math.min(...hits) + windowMilliseconds).toISOString();
}

/**
 * The sliding-window counter of one source address, reached over RPC through `checkAndConsume`.
 * Its storage never outlives the window: one alarm, armed at the earliest group expiry, prunes it
 * and deletes everything once every window has passed. Stored state that does not parse fails
 * `checkAndConsume`, and the alarm drops it.
 */
export class RateLimitIdentityDurableObject extends DurableObject {
  /**
   * Counts one request against the group's window and answers with the window's state. Over the
   * limit it refuses with `remaining: 0` and records nothing, so a refused request never extends
   * the window; `resetAt` is the instant the oldest live hit ages out.
   */
  async checkAndConsume(request: CheckAndConsumeRequest): Promise<RateLimitCheckResponse> {
    const now = Date.now();
    const windowMilliseconds = request.windowSeconds * 1000;
    // Nothing is awaited between the read and the write, so no other request runs in between; the
    // output gate holds each reply until its writes are durable.
    const { windows, unreadable } = this.#readWindows();
    if (unreadable.size > 0) throw new Error(describeUnreadable(unreadable));
    const live = liveHits(windows.get(request.group)?.hits ?? [], windowMilliseconds, now);
    if (live.length >= request.limit) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: resetAtOf(live, windowMilliseconds),
        limit: request.limit,
      };
    }
    const window: GroupWindow = { windowMilliseconds, hits: [...live, now] };
    this.ctx.storage.kv.put(request.group, window);
    windows.set(request.group, window);
    await this.ctx.storage.setAlarm(earliestExpiry(windows.values()));
    return {
      allowed: true,
      remaining: request.limit - window.hits.length,
      resetAt: resetAtOf(window.hits, windowMilliseconds),
      limit: request.limit,
    };
  }

  /**
   * Drops each group whose window has passed and prunes the rest, re-arming for the next expiry.
   * A group that does not parse is logged and dropped as expired.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const { windows, unreadable } = this.#readWindows();
    // Rate-limit state is ephemeral and bounded by its window, so discarding unreadable state is
    // safe; throwing here would refuse the address's sign-ins for good once the retries run out.
    if (unreadable.size > 0) console.error(describeUnreadable(unreadable));
    const liveWindows = new Map<string, GroupWindow>();
    for (const [group, window] of windows) {
      const hits = liveHits(window.hits, window.windowMilliseconds, now);
      if (hits.length > 0) {
        liveWindows.set(group, { windowMilliseconds: window.windowMilliseconds, hits });
      }
    }
    if (liveWindows.size === 0) {
      // At this Worker's compatibility date `deleteAll` also deletes the alarm, so nothing remains.
      await this.ctx.storage.deleteAll();
      return;
    }
    for (const group of [...windows.keys(), ...unreadable.keys()]) {
      const window = liveWindows.get(group);
      if (window === undefined) this.ctx.storage.kv.delete(group);
      else this.ctx.storage.kv.put(group, window);
    }
    await this.ctx.storage.setAlarm(earliestExpiry(liveWindows.values()));
  }

  // Stored state may have been written by an earlier code version, so every group is parsed.
  #readWindows(): StoredWindows {
    const windows = new Map<string, GroupWindow>();
    const unreadable = new Map<string, string>();
    for (const [group, value] of this.ctx.storage.kv.list()) {
      const parsed = groupWindowSchema.safeParse(value);
      if (parsed.success) windows.set(group, parsed.data);
      else unreadable.set(group, z.prettifyError(parsed.error));
    }
    return { windows, unreadable };
  }
}
