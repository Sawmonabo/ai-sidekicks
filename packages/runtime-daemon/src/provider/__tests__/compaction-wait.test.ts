// Pending-compaction wait suite (Plan-005 T3.26 — the participant-triggered
// compaction leg).
//
// Spec coverage under test:
//   • `Spec-005 §Desktop Console Parity Surfaces` — participant-triggered
//     compaction settles on the provider's own typed compaction evidence and
//     NEVER on the request being accepted, because both pinned mechanisms answer
//     before the work is done; the wait is bounded and TWICE-terminated (a
//     per-driver declared bound and the binding ceasing to be live), and
//     bounding the OPERATION never bounds the BOUNDARY'S RECORD.
//
// Verifies invariant: I-005-13 (a compaction reports `applied` only against
// observed typed evidence; every other terminal is a recorded failure, and no
// terminal suppresses the boundary row a late frame still produces).
//
// The scheduler is INJECTED throughout and no test here uses a real timer: a
// suite that waited out a declared bound to observe an expiry is a suite nobody
// runs, and — more to the point — the property under test in the binding-loss
// cases is that the settlement does NOT wait for a timer at all, which a real
// clock cannot distinguish from a merely fast one.

import { describe, expect, it } from "vitest";

import {
  PendingCompactionRegistry,
  type CompactionWaitScheduler,
  type CompactionWaitSettlement,
} from "../compaction-wait.js";

/**
 * A scheduler whose timers fire only when a test says so.
 *
 * `fireAll` is what stands in for the declared bound elapsing. Cancellation is
 * RECORDED rather than merely honoured, because "the timer was cancelled" is the
 * observable difference between a wait that settled on evidence and one that was
 * left armed to fire into a settled promise later.
 */
function makeManualScheduler(): {
  readonly schedule: CompactionWaitScheduler;
  readonly fireAll: () => void;
  readonly armedCount: () => number;
  readonly cancelledCount: () => number;
  readonly lastDelayMs: () => number | null;
} {
  const armed: { callback: () => void; cancelled: boolean }[] = [];
  let lastDelayMs: number | null = null;
  return {
    schedule: (callback, delayMs) => {
      lastDelayMs = delayMs;
      const entry = { callback, cancelled: false };
      armed.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    fireAll: () => {
      for (const entry of armed) {
        if (!entry.cancelled) {
          entry.callback();
        }
      }
    },
    armedCount: () => armed.length,
    cancelledCount: () => armed.filter((entry) => entry.cancelled).length,
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
    // `null` is the POSITIVE statement that the provider's frame named no
    // position. The alternative a driver might reach for — omitting the member,
    // or substituting a turn ordinal it happens to know — would report a
    // boundary the provider never located.
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    const wait = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    registry.observeBoundary(BINDING_KEY, null);

    await expect(wait.settled).resolves.toEqual({ terminal: "observed", boundaryPosition: null });
  });

  it("cancels the bound's timer when evidence settles the wait", async () => {
    // Otherwise the armed timer outlives the settlement and fires into a
    // resolved promise — harmless here only because `settleOnce` guards it, and
    // a leak on any driver that armed one per compaction for a long session.
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    const wait = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    registry.observeBoundary(BINDING_KEY, 1);
    await wait.settled;

    expect(scheduler.cancelledCount()).toBe(1);
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
    // The property that a periodic liveness poll cannot deliver and this test is
    // built to catch: no timer is ever fired here, so a registry that learned
    // about the loss by waking up and checking would hang this test rather than
    // pass it.
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    const wait = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    registry.releaseBinding(BINDING_KEY);

    await expect(wait.settled).resolves.toEqual({
      terminal: "binding_lost",
      boundaryPosition: null,
    });
    expect(scheduler.cancelledCount()).toBe(1);
  });

  it("never rejects — every terminal is a settlement the caller maps", async () => {
    // A rejection would make the wait's own bookkeeping indistinguishable from
    // the provider mechanism failing, and the caller's result union has a
    // distinct arm for each.
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    const expiring = registry.arm("expiring", DECLARED_BOUND_MS);
    const losing = registry.arm("losing", DECLARED_BOUND_MS);
    // The loss FIRST, then the bound. `fireAll` skips a cancelled timer, so this
    // ordering is also the assertion that settling on a loss really does cancel
    // the bound rather than leaving it armed to re-settle the same wait.
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
 * A sentinel that resolves on the microtask queue, for asserting that a promise
 * does NOT settle.
 *
 * Raced against the wait rather than awaited with a timeout: the property under
 * test is "nothing resolved it", and a timeout would report the same PASS for a
 * promise that was merely slow. Every path that could settle an armed wait —
 * evidence, the bound firing, a binding loss — is driven synchronously by these
 * tests, so one microtask turn is enough for any of them to have won the race.
 */
const NEVER_SETTLED = Symbol("never-settled");
async function raceAgainstMicrotask(
  candidate: Promise<CompactionWaitSettlement>,
): Promise<CompactionWaitSettlement | typeof NEVER_SETTLED> {
  return await Promise.race([candidate, Promise.resolve(NEVER_SETTLED)]);
}

describe("PendingCompactionRegistry — withdrawal", () => {
  it("cancels the withdrawn wait's timer and forgets its registration", async () => {
    // The leak this method exists to close. A driver whose DISPATCH threw has
    // nothing left to correlate and returns at once; without a withdrawal its
    // registration and its timer survive for the whole declared bound, which on
    // a driver whose transport deadline is shorter than that bound outlives the
    // caller by the difference.
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    const wait = registry.arm(BINDING_KEY, DECLARED_BOUND_MS);
    expect(registry.pendingCountFor(BINDING_KEY)).toBe(1);

    wait.abandon();

    expect(registry.pendingCountFor(BINDING_KEY)).toBe(0);
    expect(scheduler.cancelledCount()).toBe(1);
    await expect(raceAgainstMicrotask(wait.settled)).resolves.toBe(NEVER_SETTLED);
  });

  it("leaves a CONCURRENT waiter on the same key armed and still able to settle", async () => {
    // The distinction the whole design rests on: SETTLEMENT is per-key because
    // one provider compaction is one compaction, so settling on this caller's
    // transport failure would report that failure to a participant who asked
    // independently and is still owed the truth. WITHDRAWAL is per-waiter, so the
    // sibling keeps its own bound and still settles on the provider's evidence.
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

  it("stays withdrawn even when the bound then fires through a canceller that does nothing", async () => {
    // The `closed`-BEFORE-`cancelTimer` ordering, driven rather than asserted.
    // This scheduler's canceller is a no-op — the shape of any host whose clear
    // races the fire — so a withdrawal that relied on cancellation alone would
    // deliver `wait_expired` into a promise whose caller had already returned
    // `provider_error`, and the wait would settle after all.
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
    // A caller may withdraw on an error path that a settlement raced, and a
    // second withdrawal must not re-enter the key's bookkeeping or disturb a
    // waiter armed after it.
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
    // Bounding or withdrawing the OPERATION never bounds the BOUNDARY'S RECORD.
    // After the only waiter withdraws, the provider's own frame still reaches
    // `observeBoundary` on its ordinary route and is an ordinary no-op here,
    // because this registry is a tap beside the hand-off and never a diversion
    // from it.
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
    // Two participants can ask for a compaction on one binding at once, and the
    // result union's refusal arm is CLOSED at `command_absent` / `not_permitted`
    // — neither of which describes "someone else asked first". One provider
    // compaction is one compaction, and both callers hear the truth about it.
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
    // The registry is keyed, and a compaction observed on one live session must
    // not settle a wait armed against a different one — which would report a
    // compaction that happened somewhere else as this caller's own.
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
    // A provider-initiated compaction nobody asked for is not an error, and
    // recording a diagnostic for it would make the ordinary case noisy.
    const scheduler = makeManualScheduler();
    const registry = new PendingCompactionRegistry(scheduler.schedule);

    expect(() => {
      registry.observeBoundary(BINDING_KEY, 9);
    }).not.toThrow();
    expect(scheduler.armedCount()).toBe(0);
  });

  it("is idempotent across a second disposal", async () => {
    // A graceful teardown that runs after a quarantine already settled the
    // waiters must find an empty set and do nothing, rather than re-entering
    // settlement on a key whose registrations are gone.
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
    // A long-lived driver must not accumulate one empty Set per session it ever
    // compacted; `pendingCountFor` reading zero is the observable proxy for the
    // entry having been dropped rather than merely emptied.
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
