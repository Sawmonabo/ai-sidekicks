// One returning edge, one pass, and the ids that were still worth attempting.
//
// The binder suites drive this class through a real fixture transport, which is where
// the reading that matters is proven. These cases drive it directly, because three of
// its rules are about a pass that is INTERRUPTED — by a teardown, by a close, by a
// re-entrant edge the pass itself caused — and reaching those through a bridge would
// mean scripting a transport to fail in a particular order rather than stating the
// rule. A recorder for `rebind` and two predicates is the whole world it has.

import { describe, expect, it } from "vitest";

import { UnboundSessionRetry } from "./unbound-session-retry.js";

const FIRST_SESSION_ID = "session-first";
const SECOND_SESSION_ID = "session-second";

/** A retry whose owner is live, holds every session open, and records its re-attempts. */
function createRetry(
  overrides: {
    isRetired?: () => boolean;
    isStillOpen?: (sessionId: string) => boolean;
  } = {},
): { retry: UnboundSessionRetry; rebound: string[] } {
  const rebound: string[] = [];
  const retry = new UnboundSessionRetry({
    isRetired: overrides.isRetired ?? ((): boolean => false),
    isStillOpen: overrides.isStillOpen ?? ((): boolean => true),
    rebind: (sessionId: string): void => {
      rebound.push(sessionId);
    },
  });
  return { retry, rebound };
}

/**
 * A rebind that delivers another returning edge from inside the pass it is in.
 *
 * That is what a successful re-attempt actually causes — the open reports the wire
 * reachable — so the recorder holds the retry it re-enters, rather than a case
 * reaching for a binding that does not exist yet at the point the callback is built.
 */
class ReentrantRebinder {
  public readonly rebound: string[] = [];
  #retry: UnboundSessionRetry | undefined;

  public attachTo(retry: UnboundSessionRetry): void {
    this.#retry = retry;
  }

  public rebind(sessionId: string): void {
    this.rebound.push(sessionId);
    this.#retry?.runOnePass();
  }
}

describe("UnboundSessionRetry", () => {
  it("re-attempts every retained session once, in the order they failed", () => {
    const { retry, rebound } = createRetry();
    retry.retain(FIRST_SESSION_ID);
    retry.retain(SECOND_SESSION_ID);

    retry.runOnePass();

    expect(rebound).toEqual([FIRST_SESSION_ID, SECOND_SESSION_ID]);
    expect(retry.retriedBindCount).toBe(2);
  });

  it("negative control: a pass over nothing retained attempts nothing", () => {
    // Without it, a class that re-attempted some remembered id of its own — the last
    // one, the whole open set — would pass the case above unnoticed.
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
    // A window that failed the same open three times must re-attempt it once, not
    // three times: the set is the state, and a list would make the retry count a
    // count of failures rather than of attempts.
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
    // A returning edge reaches a SNAPSHOT of the signal's sinks, so a teardown can
    // land while a pass is walking. Asked before every attempt rather than once at
    // entry, so the count stays a count of attempts the owner actually made.
    const rebound: string[] = [];
    let retired = false;
    const retry = new UnboundSessionRetry({
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
    // The re-entrancy the flag exists for: a re-attempt that succeeds reports the
    // wire reachable, which IS a returning edge and arrives back in this method
    // mid-walk. One pass is what an edge is worth, so the nested delivery is a
    // no-op rather than a second walk that re-attempts and double-counts.
    const rebinder = new ReentrantRebinder();
    const retry = new UnboundSessionRetry({
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
