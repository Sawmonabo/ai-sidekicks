// The pending-compaction wait: a user-triggered compaction settles on the provider's own typed
// compaction evidence, never on the request being accepted, because both pinned mechanisms answer
// before the work is done. The wait ends two ways: a per-driver declared bound, or the binding
// ceasing to be live. Bounding the operation never bounds the boundary's record.
//
// The scheduler is injected and no test uses a real timer: the binding-loss cases assert that
// settlement does not wait for a timer at all, which a real clock cannot tell from a fast one.

import { describe, expect, it } from "vitest";

import {
  PendingCompactionRegistry,
  type CompactionWaitScheduler,
  type CompactionWaitSettlement,
} from "../compaction-wait.js";

/**
 * A scheduler whose timers fire only when a test says so; `fireAll` stands in for the declared
 * bound elapsing. Cancellation is recorded, since a canceled timer is the observable difference
 * between a wait that settled on evidence and one left armed to fire later.
 */
function makeManualScheduler(): {
  readonly schedule: CompactionWaitScheduler;
  readonly fireAll: () => void;
  readonly armedCount: () => number;
  readonly canceledCount: () => number;
  readonly lastDelayMs: () => number | null;
} {
  const armed: { callback: () => void; canceled: boolean }[] = [];
  let lastDelayMs: number | null = null;
  return {
    schedule: (callback, delayMs) => {
      lastDelayMs = delayMs;
      const entry = { callback, canceled: false };
      armed.push(entry);
      return () => {
        entry.canceled = true;
      };
    },
    fireAll: () => {
      for (const entry of armed) {
        if (!entry.canceled) {
          entry.callback();
        }
      }
    },
    armedCount: () => armed.length,
    canceledCount: () => armed.filter((entry) => entry.canceled).length,
    lastDelayMs: () => lastDelayMs,
  };
}

const BINDING_KEY = "session-under-compaction";
const DECLARED_BOUND_MS = 90_000;

describe("PendingCompactionRegistry — the observed terminal", () => {
  it("settles `observed` with the position the provider's frame named", async () => {
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    const wait = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    registry.observeBoundary(BINDING_KEY, 42);

    await expect(wait.settled).resolves.toEqual({ terminal: "observed", boundaryPosition: 42 });
    expect(scheduler.lastDelayMs()).toBe(DECLARED_BOUND_MS);
  });

  it("carries a position-less frame as `null` rather than synthesizing one", async () => {
    // `null` states that the provider's frame named no position. Omitting the member or
    // substituting a turn ordinal would report a boundary the provider never located.
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    const wait = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    registry.observeBoundary(BINDING_KEY, null);

    await expect(wait.settled).resolves.toEqual({ terminal: "observed", boundaryPosition: null });
  });

  it("cancels the bound's timer when evidence settles the wait", async () => {
    // Otherwise the armed timer outlives the settlement and fires into a resolved promise: harmless
    // only because `settleOnce` guards it, and a leak when one is armed per compaction.
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    const wait = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    registry.observeBoundary(BINDING_KEY, 1);
    await wait.settled;

    expect(scheduler.canceledCount()).toBe(1);
  });
});

describe("PendingCompactionRegistry — the two failure terminals", () => {
  it("settles `wait_expired` when the declared bound elapses with no evidence", async () => {
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    const wait = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    scheduler.fireAll();

    await expect(wait.settled).resolves.toEqual({
      terminal: "wait_expired",
      boundaryPosition: null,
    });
  });

  it("settles `binding_lost` IMMEDIATELY, without the bound elapsing", async () => {
    // No timer is ever fired here, so a registry that learned of the loss by waking up and
    // checking would hang this test rather than pass it.
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    const wait = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    registry.releaseBinding(BINDING_KEY);

    await expect(wait.settled).resolves.toEqual({
      terminal: "binding_lost",
      boundaryPosition: null,
    });
    expect(scheduler.canceledCount()).toBe(1);
  });

  it("never rejects — every terminal is a settlement the caller maps", async () => {
    // A rejection would make the wait's own bookkeeping indistinguishable from the provider
    // mechanism failing, and the caller's result union has a distinct arm for each.
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    const expiring = registry.arm("expiring", DECLARED_BOUND_MS);
    const losing = registry.arm("losing", DECLARED_BOUND_MS);
    // The loss first, then the bound. `fireAll` skips a canceled timer, so this order also asserts
    // that settling on a loss cancels the bound rather than leaving it armed.
    registry.releaseBinding("losing");
    scheduler.fireAll();

    const settlements: CompactionWaitSettlement[] = await Promise.all([
      expiring.settled,
      losing.settled,
    ]);
    expect(settlements.map((settlement) => settlement.terminal)).toEqual([
      "wait_expired",
      "binding_lost",
    ]);
  });
});

/**
 * A sentinel that resolves on the microtask queue, for asserting that a promise does not settle.
 * Every path that could settle an armed wait is driven synchronously by these tests, so one
 * microtask turn is enough for any of them to have won the race; a timeout would pass a slow one.
 */
const NEVER_SETTLED = Symbol("never-settled");
async function raceAgainstMicrotask(
  candidate: Promise<CompactionWaitSettlement>,
): Promise<CompactionWaitSettlement | typeof NEVER_SETTLED> {
  return await Promise.race([candidate, Promise.resolve(NEVER_SETTLED)]);
}

describe("PendingCompactionRegistry — withdrawal", () => {
  it("cancels the withdrawn wait's timer and forgets its registration", async () => {
    // A driver whose dispatch threw has nothing left to correlate and returns at once; without a
    // withdrawal its registration and timer survive for the whole declared bound.
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    const wait = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    expect(registry.pendingCountFor(BINDING_KEY)).toBe(1);

    wait.abandon();

    expect(registry.pendingCountFor(BINDING_KEY)).toBe(0);
    expect(scheduler.canceledCount()).toBe(1);
    await expect(raceAgainstMicrotask(wait.settled)).resolves.toBe(NEVER_SETTLED);
  });

  it("leaves a CONCURRENT waiter on the same key armed and still able to settle", async () => {
    // Settlement is per key, because one provider compaction is one compaction. Withdrawal is per
    // waiter, so the sibling keeps its own bound and still settles on the provider's evidence.
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    const withdrawn = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    const sibling = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    expect(registry.pendingCountFor(BINDING_KEY)).toBe(2);

    withdrawn.abandon();
    expect(registry.pendingCountFor(BINDING_KEY)).toBe(1);

    registry.observeBoundary(BINDING_KEY, 11);

    await expect(sibling.settled).resolves.toEqual({ terminal: "observed", boundaryPosition: 11 });
    await expect(raceAgainstMicrotask(withdrawn.settled)).resolves.toBe(NEVER_SETTLED);
  });

  it("stays withdrawn even when the bound then fires through a canceler that does nothing", async () => {
    // The `closed`-before-`cancelTimer` ordering, driven. This canceler is a no-op, as for a host
    // whose clear races the fire, so a withdrawal relying on cancellation alone would deliver
    // `wait_expired` to a caller that already returned `provider_error`.
    const firedRegardless: (() => void)[] = [];
    const registry = new PendingCompactionRegistry((callback) => {
      firedRegardless.push(callback);
      return (): void => {
        // Deliberately does not stop the timer.
      };
    });

    const wait = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    wait.abandon();
    for (const fire of firedRegardless) {
      fire();
    }

    await expect(raceAgainstMicrotask(wait.settled)).resolves.toBe(NEVER_SETTLED);
    expect(registry.pendingCountFor(BINDING_KEY)).toBe(0);
  });

  it("is idempotent, and a no-op on a wait that already settled", async () => {
    // A caller may withdraw on an error path that a settlement raced; a second withdrawal must
    // not re-enter the key's bookkeeping or disturb a waiter armed after it.
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    const settledWait = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    registry.observeBoundary(BINDING_KEY, 5);
    await expect(settledWait.settled).resolves.toEqual({
      terminal: "observed",
      boundaryPosition: 5,
    });

    const successor = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    expect(() => {
      settledWait.abandon();
      settledWait.abandon();
    }).not.toThrow();

    expect(registry.pendingCountFor(BINDING_KEY)).toBe(1);
    registry.releaseBinding(BINDING_KEY);
    await expect(successor.settled).resolves.toEqual({
      terminal: "binding_lost",
      boundaryPosition: null,
    });
  });

  it("does not suppress the boundary record — an unwaited compaction is still a tap", () => {
    // After the only waiter withdraws, the provider's frame still reaches `observeBoundary` and is
    // an ordinary no-op: this registry is a tap beside the hand-off, never a diversion from it.
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    const wait = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    wait.abandon();

    expect(() => {
      registry.observeBoundary(BINDING_KEY, 13);
    }).not.toThrow();
  });
});

describe("PendingCompactionRegistry — scoping and bookkeeping", () => {
  it("settles EVERY waiter on one key from a single terminal", async () => {
    // Two users can ask for a compaction on one binding at once, and the result union's refusal
    // arm is closed at `command_absent` / `not_permitted`, neither of which means "someone else
    // asked first". One provider compaction is one compaction, and both callers hear about it.
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    const first = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    const second = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    expect(registry.pendingCountFor(BINDING_KEY)).toBe(2);

    registry.observeBoundary(BINDING_KEY, 7);

    await expect(first.settled).resolves.toEqual({ terminal: "observed", boundaryPosition: 7 });
    await expect(second.settled).resolves.toEqual({ terminal: "observed", boundaryPosition: 7 });
    expect(registry.pendingCountFor(BINDING_KEY)).toBe(0);
  });

  it("leaves another binding's wait untouched", async () => {
    // A compaction observed on one live session must not settle a wait armed against another,
    // which would report a compaction that happened elsewhere as this caller's own.
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    const observed = registry.arm("session-a", DECLARED_BOUND_MS);
    const untouched = registry.arm("session-b", DECLARED_BOUND_MS);

    registry.observeBoundary("session-a", 3);
    await expect(observed.settled).resolves.toEqual({ terminal: "observed", boundaryPosition: 3 });
    expect(registry.pendingCountFor("session-b")).toBe(1);

    registry.releaseBinding("session-b");
    await expect(untouched.settled).resolves.toEqual({
      terminal: "binding_lost",
      boundaryPosition: null,
    });
  });

  it("treats a boundary with no armed waiter as an ordinary no-op", () => {
    // A provider-initiated compaction nobody asked for is not an error, and a diagnostic for it
    // would make the ordinary case noisy.
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    expect(() => {
      registry.observeBoundary(BINDING_KEY, 9);
    }).not.toThrow();
    expect(scheduler.armedCount()).toBe(0);
  });

  it("is idempotent across a second disposal", async () => {
    // A graceful teardown after a quarantine already settled the waiters must find an empty set
    // and do nothing.
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    const wait = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    registry.releaseBinding(BINDING_KEY);
    await wait.settled;

    expect(() => {
      registry.releaseBinding(BINDING_KEY);
    }).not.toThrow();
    expect(registry.pendingCountFor(BINDING_KEY)).toBe(0);
  });

  it("forgets a key's entry with its last waiter", async () => {
    // A long-lived driver must not accumulate one empty Set per session it ever compacted;
    // `pendingCountFor` reading zero is the observable proxy for the entry having been dropped.
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    const first = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    registry.observeBoundary(BINDING_KEY, 1);
    await first.settled;

    const second = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    expect(registry.pendingCountFor(BINDING_KEY)).toBe(1);
    registry.releaseBinding(BINDING_KEY);
    await second.settled;
    expect(registry.pendingCountFor(BINDING_KEY)).toBe(0);
  });
});
