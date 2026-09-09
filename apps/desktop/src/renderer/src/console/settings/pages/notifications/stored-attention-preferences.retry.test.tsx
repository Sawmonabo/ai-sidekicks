// The identity read that refused, and the window focus that asks again.
//
// THE CHAIN HAS A FRONT LINK AND IT USED TO RUN ONCE. The page reads who this caller
// is before it reads that participant's preference set, and the identity call was made
// from a `useEffect` keyed on the bridge and the retained session. A transport outage
// — a call that rejects, or one the daemon answers `unavailable` — left those
// dependencies exactly where they were, so nothing ever asked again; and because the
// preference reading takes the participant as its SUBJECT, with none it refuses every
// focus and every reconnect by design. The section was unusable for the life of the
// window and the only way back was to leave the page and return to it.
//
// SO THIS SUITE DRIVES THE PAGE RATHER THAN THE READING. What is under test is that a
// window trigger reaches all the way through — the focus asks who this is, the answer
// names a participant, and the reading held for that participant reads its own set —
// and only a mounted page has both halves of the chain in it.

import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";

import { growthUnavailable } from "../../../bridge/index.js";
import type { CallerParticipantOutcome } from "../../../seats/index.js";
import {
  SERVED_PARTICIPANT,
  bridgeWith,
  renderPageAt,
  servedPreferences,
  settle,
  storedLabels,
  SESSION_ID,
} from "./notifications-page.test-support.js";
import { PARTICIPANT_ID } from "./notification-preference-writer.test-support.js";

/**
 * An identity read that refuses `attemptsRefused` times and then names somebody.
 *
 * A counter rather than a scripted queue, so a case states how many attempts it is
 * about and the stub cannot silently run out of answers halfway through a retry.
 */
function identityRefusingFirst(attemptsRefused: number): () => Promise<CallerParticipantOutcome> {
  let attempts = 0;
  return async () => {
    attempts += 1;
    if (attempts <= attemptsRefused) {
      throw new Error("the transport is not carrying anything right now");
    }
    return await Promise.resolve(SERVED_PARTICIPANT);
  };
}

/** Raise the window's own focus trigger, as returning to the window does. */
async function focusTheWindow(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await crossMacrotaskBoundary();
  });
}

describe("the notifications page — a refused identity read is asked again", () => {
  it("finishes the chain on the focus after a rejected identity read", async () => {
    const callerParticipantRead = vi.fn(identityRefusingFirst(1));
    const bridge = bridgeWith({
      callerParticipantRead,
      attentionPreferenceRead: async () =>
        await Promise.resolve(servedPreferences([{ key: "attention", value: { mentions: true } }])),
    });
    const container = renderPageAt(bridge, SESSION_ID);
    await settle(bridge);

    // The negative control for the assertion below, and the defect stated as a fact:
    // the first attempt refused, so there is no participant and therefore no set. If
    // the page rendered rows here the retry case would be vacuous.
    expect(storedLabels(container)).toHaveLength(0);
    expect(callerParticipantRead).toHaveBeenCalledTimes(1);

    await focusTheWindow();
    await settle(bridge);

    // THE FIX. The focus reaches the identity read, the identity read answers, and
    // the reading minted for that participant reads its own set — all through the
    // window triggers the rest of the console already takes. Before it, this stayed
    // empty for the life of the window.
    expect(callerParticipantRead).toHaveBeenCalledTimes(2);
    expect(storedLabels(container).length).toBeGreaterThan(0);
  });

  it("asks again after a refusal the daemon put in its own words", async () => {
    // The other refusal arm. `unavailable` is a served reply rather than a rejection,
    // and it stopped the chain exactly as hard: the outcome carries no participant, so
    // the reading behind it had no subject either.
    let attempts = 0;
    const bridge = bridgeWith({
      callerParticipantRead: async () => {
        attempts += 1;
        return await Promise.resolve(
          attempts === 1 ? growthUnavailable("callerParticipantRead") : SERVED_PARTICIPANT,
        );
      },
      attentionPreferenceRead: async ({ participantId }) => {
        expect(participantId).toBe(PARTICIPANT_ID);
        return await Promise.resolve(
          servedPreferences([{ key: "attention", value: { mentions: false } }]),
        );
      },
    });
    const container = renderPageAt(bridge, SESSION_ID);
    await settle(bridge);
    expect(storedLabels(container)).toHaveLength(0);

    await focusTheWindow();
    await settle(bridge);

    expect(attempts).toBe(2);
    expect(storedLabels(container).length).toBeGreaterThan(0);
  });

  it("negative control: an identity read that keeps refusing keeps the section empty", async () => {
    // Without this the cases above would pass over a page that rendered the set
    // regardless of what the identity read said — which is the opposite defect and
    // would put one participant's switches under another's name.
    const callerParticipantRead = vi.fn(identityRefusingFirst(Number.POSITIVE_INFINITY));
    const bridge = bridgeWith({ callerParticipantRead });
    const container = renderPageAt(bridge, SESSION_ID);
    await settle(bridge);
    await focusTheWindow();
    await settle(bridge);

    expect(callerParticipantRead.mock.calls.length).toBeGreaterThan(1);
    expect(storedLabels(container)).toHaveLength(0);
  });
});
