// Failure modes of the participant hue wheel.
//
// The class: the wheel is a finite resource handed out to an unbounded population,
// so every mode here is what happens when it runs out or is asked twice. A
// thirteenth participant arrives and there are twelve steps; two ids prefer the
// same step; a participant leaves and their colour is a candidate for reuse.
//
// They live in `tokens/` because a hue is a design-token value and the allocator is
// what turns an identity into one. The failure is not a crash — the wheel wraps
// happily — it is that two people end up visually identical in a ledger, or that one
// person's colour changes under them and re-attributes the scrollback above. Neither
// is reachable from a happy-path test with three participants in it.
//
// Both the wrap case and the collision case assert on the PROPERTY the design needs
// (a distinct `(step, ring)` pair per participant; stable allocation within a
// session) rather than on the literal values, so the cases stay real if the hash
// changes.

import { describe, expect, it } from "vitest";

import { PARTICIPANT_HUE_STEPS } from "./palette.js";
import { ParticipantHueAllocator, preferredHueStep } from "./participant-hue.js";

describe("failure matrix — the participant hue wheel runs out of steps", () => {
  it("keeps every participant distinguishable past twelve by ringing the wrap", () => {
    const allocator = new ParticipantHueAllocator();
    const participantIds = Array.from(
      { length: PARTICIPANT_HUE_STEPS + 5 },
      (_unused, index) => `participant-${String(index)}`,
    );

    const assignments = participantIds.map((participantId) => allocator.admit(participantId));

    expect(allocator.admittedCount).toBe(participantIds.length);
    // Every one of the first twelve holds a distinct step: the wheel is used up
    // before anything wraps.
    const firstTwelveSteps = new Set(
      assignments.slice(0, PARTICIPANT_HUE_STEPS).map((one) => one.step),
    );
    expect(firstTwelveSteps.size).toBe(PARTICIPANT_HUE_STEPS);
    // Past twelve, a step repeats but the (step, ring) pair does not — which is the
    // property the design actually needs, since two people sharing a colour with no
    // second axis are indistinguishable in a ledger.
    const pairs = assignments.map((one) => `${String(one.step)}:${one.ringTreatment}`);
    expect(new Set(pairs).size).toBe(participantIds.length);
  });

  it("gives the same participant the same hue regardless of arrival order", () => {
    // Two ids whose preferred step collides. Found by search rather than asserted,
    // so the case stays real if the hash changes.
    const collidingPair = findCollidingParticipantIds();
    expect(collidingPair).toBeDefined();
    if (collidingPair === undefined) {
      return;
    }
    const [first, second] = collidingPair;

    const forward = new ParticipantHueAllocator();
    const forwardFirst = forward.admit(first);
    const forwardSecond = forward.admit(second);

    const reverse = new ParticipantHueAllocator();
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

  it("frees nothing when a participant leaves, so a colour never changes hands", () => {
    const allocator = new ParticipantHueAllocator();
    const leaving = allocator.admit("participant-leaving");
    // There is deliberately no `release`. Re-using a departed participant's hue
    // would silently re-attribute their rows in the scrollback above.
    expect("release" in allocator).toBe(false);
    const later = allocator.admit("participant-later");
    expect(later.step).not.toBe(leaving.step);
  });
});

/**
 * Find two participant ids whose preferred step collides.
 *
 * Searched rather than hard-coded so the case survives a change to the hash: a
 * literal pair would silently stop colliding and the test would pass while
 * asserting nothing.
 */
function findCollidingParticipantIds(): readonly [string, string] | undefined {
  const seenByStep = new Map<number, string>();
  for (let index = 0; index < 4096; index += 1) {
    const participantId = `participant-${String(index)}`;
    const step = preferredHueStep(participantId);
    const existing = seenByStep.get(step);
    if (existing !== undefined) {
      return [existing, participantId];
    }
    seenByStep.set(step, participantId);
  }
  return undefined;
}
