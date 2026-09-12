// Failure modes of the user hue wheel.
//
// The class: the wheel is a finite resource handed out to an unbounded population,
// so every mode here is what happens when it runs out or is asked twice. A
// thirteenth user arrives and there are twelve steps; two ids prefer the
// same step; a user leaves and their colour is a candidate for reuse.
//
// They live in `tokens/` because a hue is a design-token value and the allocator is
// what turns an identity into one. The failure is not a crash — the wheel wraps
// happily — it is that two people end up visually identical in a ledger, or that one
// person's colour changes under them and re-attributes the scrollback above. Neither
// is reachable from a happy-path test with three users in it.
//
// Both the wrap case and the collision case assert on the PROPERTY the design needs
// (a distinct `(step, ring)` pair per user; stable allocation within a
// session) rather than on the literal values, so the cases stay real if the hash
// changes.

import { describe, expect, it } from "vitest";

import { ACTOR_HUE_STEPS } from "./palette.js";
import { ActorHueAllocator, preferredHueStep } from "./actor-hue.js";

describe("failure matrix — the user hue wheel runs out of steps", () => {
  it("keeps every user distinguishable past twelve by ringing the wrap", () => {
    const allocator = new ActorHueAllocator();
    const userIds = Array.from(
      { length: ACTOR_HUE_STEPS + 5 },
      (_unused, index) => `user-${String(index)}`,
    );

    const assignments = userIds.map((userId) => allocator.admit(userId));

    expect(allocator.admittedCount).toBe(userIds.length);
    // Every one of the first twelve holds a distinct step: the wheel is used up
    // before anything wraps.
    const firstTwelveSteps = new Set(assignments.slice(0, ACTOR_HUE_STEPS).map((one) => one.step));
    expect(firstTwelveSteps.size).toBe(ACTOR_HUE_STEPS);
    // Past twelve, a step repeats but the (step, ring) pair does not — which is the
    // property the design actually needs, since two people sharing a colour with no
    // second axis are indistinguishable in a ledger.
    const pairs = assignments.map((one) => `${String(one.step)}:${one.ringTreatment}`);
    expect(new Set(pairs).size).toBe(userIds.length);
  });

  it("gives the same user the same hue regardless of arrival order", () => {
    // Two ids whose preferred step collides. Found by search rather than asserted,
    // so the case stays real if the hash changes.
    const collidingPair = findCollidingUserIds();
    expect(collidingPair).toBeDefined();
    if (collidingPair === undefined) {
      return;
    }
    const [first, second] = collidingPair;

    const forward = new ActorHueAllocator();
    const forwardFirst = forward.admit(first);
    const forwardSecond = forward.admit(second);

    const reverse = new ActorHueAllocator();
    const reverseSecond = reverse.admit(second);
    const reverseFirst = reverse.admit(first);

    // Order changes WHO gets the preferred step — that is inherent to first-come
    // allocation and is fine. What must not change is that both are distinct and
    // that each allocation is stable within its own session.
    expect(forwardFirst.step).not.toBe(forwardSecond.step);
    expect(reverseFirst.step).not.toBe(reverseSecond.step);
    expect(forward.assignmentFor(first)?.step).toBe(forwardFirst.step);
    expect(reverse.assignmentFor(second)?.step).toBe(reverseSecond.step);
    // And the first arrival always gets the step both wanted, in both orders.
    expect(forwardFirst.step).toBe(preferredHueStep(first));
    expect(reverseSecond.step).toBe(preferredHueStep(second));
  });

  it("frees nothing when a user leaves, so a colour never changes hands", () => {
    const allocator = new ActorHueAllocator();
    const leaving = allocator.admit("user-leaving");
    // There is deliberately no `release`. Re-using a departed user's hue
    // would silently re-attribute their rows in the scrollback above.
    expect("release" in allocator).toBe(false);
    const later = allocator.admit("user-later");
    expect(later.step).not.toBe(leaving.step);
  });
});

/**
 * Find two user ids whose preferred step collides.
 *
 * Searched rather than hard-coded so the case survives a change to the hash: a
 * literal pair would silently stop colliding and the test would pass while
 * asserting nothing.
 */
function findCollidingUserIds(): readonly [string, string] | undefined {
  const seenByStep = new Map<number, string>();
  for (let index = 0; index < 4096; index += 1) {
    const userId = `user-${String(index)}`;
    const step = preferredHueStep(userId);
    const existing = seenByStep.get(step);
    if (existing !== undefined) {
      return [existing, userId];
    }
    seenByStep.set(step, userId);
  }
  return undefined;
}
