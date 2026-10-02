// The pending-compaction wait settles only on the provider's own compaction frame, the declared
// bound or the binding's loss, per key; a withdrawn waiter never settles. Timers are injected so
// "settles without waiting for the bound" is observable.

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
});

describe("PendingCompactionRegistry — scoping by key", () => {
  it("settles EVERY waiter on one key from a single terminal", async () => {
    // Two requests (the person on two devices) can ask for a compaction on one binding at once,
    // and the result union's refusal arm is closed at `command_absent` / `not_permitted`, neither
    // of which means "someone else asked first". One provider compaction is one compaction, and
    // both callers hear about it.
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
});
