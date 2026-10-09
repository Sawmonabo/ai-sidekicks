// The pending-compaction wait settles only on the provider's own compaction frame, the end of the
// compaction's turn or the binding's loss, per key, with no time limit of its own; a withdrawn
// waiter never settles.

import { describe, expect, it } from "vitest";

import { PendingCompactionRegistry, type CompactionWaitSettlement } from "../compaction-wait.js";

const BINDING_KEY = "session-under-compaction";

describe("PendingCompactionRegistry — its terminals", () => {
  it("settles `observed` with the position the provider's frame named", async () => {
    const registry = new PendingCompactionRegistry();

    const wait = registry.arm(BINDING_KEY);
    registry.observeBoundary(BINDING_KEY, 42);

    await expect(wait.settled).resolves.toEqual({ terminal: "observed", boundaryPosition: 42 });
  });

  it("settles `binding_lost` at once when the binding goes", async () => {
    const registry = new PendingCompactionRegistry();

    const wait = registry.arm(BINDING_KEY);
    registry.releaseBinding(BINDING_KEY);

    await expect(wait.settled).resolves.toEqual({
      terminal: "binding_lost",
      boundaryPosition: null,
    });
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
    // waiter, so the sibling still settles on the provider's evidence.
    const registry = new PendingCompactionRegistry();

    const withdrawn = registry.arm(BINDING_KEY);
    const sibling = registry.arm(BINDING_KEY);
    expect(registry.pendingCountFor(BINDING_KEY)).toBe(2);

    withdrawn.abandon();
    expect(registry.pendingCountFor(BINDING_KEY)).toBe(1);

    registry.observeBoundary(BINDING_KEY, 11);

    await expect(sibling.settled).resolves.toEqual({ terminal: "observed", boundaryPosition: 11 });
    await expect(raceAgainstMicrotask(withdrawn.settled)).resolves.toBe(NEVER_SETTLED);
  });
});

describe("PendingCompactionRegistry — scoping by key", () => {
  it("settles EVERY waiter on one key from a single terminal", async () => {
    // Two requests (the person on two devices) can ask for a compaction on one binding at once,
    // and the result union's one refusal, `command_absent`, does not mean "someone else asked
    // first". One provider compaction is one compaction, and both callers hear about it.
    const registry = new PendingCompactionRegistry();

    const first = registry.arm(BINDING_KEY);
    const second = registry.arm(BINDING_KEY);
    expect(registry.pendingCountFor(BINDING_KEY)).toBe(2);

    registry.observeBoundary(BINDING_KEY, 7);

    await expect(first.settled).resolves.toEqual({ terminal: "observed", boundaryPosition: 7 });
    await expect(second.settled).resolves.toEqual({ terminal: "observed", boundaryPosition: 7 });
    expect(registry.pendingCountFor(BINDING_KEY)).toBe(0);
  });

  it("leaves another binding's wait untouched", async () => {
    // A compaction observed on one live session must not settle a wait armed against another,
    // which would report a compaction that happened elsewhere as this caller's own.
    const registry = new PendingCompactionRegistry();

    const observed = registry.arm("session-a");
    const untouched = registry.arm("session-b");

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
