// One returning edge, one pass, and the ids still worth attempting. The subscriber suites cover
// this class through a real fixture transport; these cases drive it directly because three of its
// rules concern an interrupted pass (a teardown, a close, a re-entrant edge), which a bridge would
// have to be scripted to fail in a particular order to reach.

import { describe, expect, it } from "vitest";

import { FailedSubscriptionRetry } from "./failed-subscription-retry.js";

const FIRST_SESSION_ID = "session-first";
const SECOND_SESSION_ID = "session-second";

/** A retry whose owner is live, holds every session open, and records its re-attempts. */
function createRetry(
  overrides: {
    isRetired?: () => boolean;
    isStillOpen?: (sessionId: string) => boolean;
  } = {},
): { retry: FailedSubscriptionRetry; rebound: string[] } {
  const rebound: string[] = [];
  const retry = new FailedSubscriptionRetry({
    isRetired: overrides.isRetired ?? ((): boolean => false),
    isStillOpen: overrides.isStillOpen ?? ((): boolean => true),
    rebind: (sessionId: string): void => {
      rebound.push(sessionId);
    },
  });
  return { retry, rebound };
}

/**
 * A rebind that delivers another returning edge from inside the pass it is in, as a successful
 * re-attempt does. The recorder holds the retry it re-enters.
 */
class ReentrantRebinder {
  public readonly rebound: string[] = [];
  #retry: FailedSubscriptionRetry | undefined;

  public attachTo(retry: FailedSubscriptionRetry): void {
    this.#retry = retry;
  }

  public rebind(sessionId: string): void {
    this.rebound.push(sessionId);
    this.#retry?.runOnePass();
  }
}

describe("FailedSubscriptionRetry", () => {
  it("re-attempts every retained session once, in the order they failed", () => {
    const { retry, rebound } = createRetry();
    retry.retain(FIRST_SESSION_ID);
    retry.retain(SECOND_SESSION_ID);

    retry.runOnePass();

    expect(rebound).toEqual([FIRST_SESSION_ID, SECOND_SESSION_ID]);
    expect(retry.retriedBindCount).toBe(2);
  });

  it("negative control: a pass over nothing retained attempts nothing", () => {
    // Without it, a class that re-attempted some id of its own would pass the case above.
    const { retry, rebound } = createRetry();

    retry.runOnePass();

    expect(rebound).toEqual([]);
    expect(retry.retriedBindCount).toBe(0);
  });

  it("retains an id until it is forgotten, and reports the set as it stands", () => {
    const { retry } = createRetry();
    retry.retain(FIRST_SESSION_ID);
    retry.retain(SECOND_SESSION_ID);
    expect(retry.retainedSessionIds).toEqual([FIRST_SESSION_ID, SECOND_SESSION_ID]);

    retry.forget(FIRST_SESSION_ID);

    expect(retry.retainedSessionIds).toEqual([SECOND_SESSION_ID]);
  });

  it("retains one id per session however many times its open failed", () => {
    // Failing the same open three times must re-attempt it once: the set is the state, so the retry
    // count counts attempts, not failures.
    const { retry, rebound } = createRetry();
    retry.retain(FIRST_SESSION_ID);
    retry.retain(FIRST_SESSION_ID);
    retry.retain(FIRST_SESSION_ID);

    retry.runOnePass();

    expect(rebound).toEqual([FIRST_SESSION_ID]);
  });

  it("drops a session that closed since it failed, without attempting it", () => {
    const closed = new Set<string>([FIRST_SESSION_ID]);
    const { retry, rebound } = createRetry({
      isStillOpen: (sessionId: string): boolean => !closed.has(sessionId),
    });
    retry.retain(FIRST_SESSION_ID);
    retry.retain(SECOND_SESSION_ID);

    retry.runOnePass();

    expect(rebound).toEqual([SECOND_SESSION_ID]);
    expect(retry.retriedBindCount).toBe(1);
    // Dropped rather than merely skipped: the next edge must not walk it again.
    expect(retry.retainedSessionIds).toEqual([SECOND_SESSION_ID]);
  });

  it("attempts nothing once the owner is retired", () => {
    let retired = false;
    const { retry, rebound } = createRetry({ isRetired: (): boolean => retired });
    retry.retain(FIRST_SESSION_ID);

    retired = true;
    retry.runOnePass();

    expect(rebound).toEqual([]);
    expect(retry.retriedBindCount).toBe(0);
  });

  it("stops a pass that is retired part-way through it", () => {
    // A returning edge reaches a snapshot of the signal's sinks, so a teardown can land mid-walk.
    // Asked before every attempt so the count is of attempts the owner made.
    const rebound: string[] = [];
    let retired = false;
    const retry = new FailedSubscriptionRetry({
      isRetired: (): boolean => retired,
      isStillOpen: (): boolean => true,
      rebind: (sessionId: string): void => {
        rebound.push(sessionId);
        retired = true;
      },
    });
    retry.retain(FIRST_SESSION_ID);
    retry.retain(SECOND_SESSION_ID);

    retry.runOnePass();

    expect(rebound).toEqual([FIRST_SESSION_ID]);
    expect(retry.retriedBindCount).toBe(1);
  });

  it("makes one pass even when an attempt inside it delivers another edge", () => {
    // A successful re-attempt reports the wire reachable, which is a returning edge arriving back
    // mid-walk; the nested delivery must be a no-op, not a second walk that double-counts.
    const rebinder = new ReentrantRebinder();
    const retry = new FailedSubscriptionRetry({
      isRetired: (): boolean => false,
      isStillOpen: (): boolean => true,
      rebind: (sessionId: string): void => {
        rebinder.rebind(sessionId);
      },
    });
    rebinder.attachTo(retry);
    retry.retain(FIRST_SESSION_ID);
    retry.retain(SECOND_SESSION_ID);

    retry.runOnePass();

    expect(rebinder.rebound).toEqual([FIRST_SESSION_ID, SECOND_SESSION_ID]);
    expect(retry.retriedBindCount).toBe(2);
  });

  it("clears every promise to re-attempt, and a later pass attempts nothing", () => {
    const { retry, rebound } = createRetry();
    retry.retain(FIRST_SESSION_ID);

    retry.clear();
    retry.runOnePass();

    expect(retry.retainedSessionIds).toEqual([]);
    expect(rebound).toEqual([]);
  });
});
