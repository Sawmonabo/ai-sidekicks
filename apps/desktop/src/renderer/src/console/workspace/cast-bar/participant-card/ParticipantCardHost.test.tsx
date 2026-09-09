// The card a chip opens, and who it names.
//
// WHAT THIS FILE PINS AND WHAT IT DOES NOT. The bar mounts ONE card host for every chip
// in it rather than a tooltip root per chip, and that is a cost property: a root per
// chip put eight floating roots inside every console mount and `ConsoleRoot.routing`
// stopped settling inside its five-second bound. It is pinned THERE, in the suite that
// actually fails on it — measured in both directions before this file was written. It is
// deliberately NOT claimed here: the library closes one tooltip when the next opens, so
// the DOM holds a single card under either arrangement and an assertion counting cards
// would pass on the shape it was written to reject. That was checked rather than assumed,
// by running these cases against the per-chip arrangement.
//
// What is left is worth having on its own: a card opens from the chip a person points
// at, and it names THAT participant rather than a remembered one.

import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CastBar } from "../CastBar.js";
import {
  AGENT_ARCHITECT,
  PARTICIPANT_PRIYA,
} from "../../../bridge/scenarios/flagship/flagship-cast.js";
import {
  SESSION_ID,
  admittedMember,
  attachedAgent,
  renderBar,
  storeWith,
} from "../CastBar.test-support.js";

/**
 * Past the library's own hover delay.
 *
 * The tooltip opens on a timer rather than on the pointer event, so a case that only
 * fired the event would assert against a card that had not been asked for yet. Driven
 * through fake timers rather than a real wait, so the suite spends no wall clock.
 */
const HOVER_DELAY_MS = 1_000;

function chipFor(bar: HTMLElement, label: string): HTMLElement {
  const chip = [...bar.querySelectorAll(".meridian-cast-chip")].find((candidate) =>
    (candidate.textContent ?? "").includes(label),
  );
  if (!(chip instanceof HTMLElement)) {
    throw new Error(`no chip named ${label}`);
  }
  return chip;
}

/** Point at a chip and let the library's delay elapse. */
function pointAt(chip: HTMLElement): void {
  act(() => {
    fireEvent.pointerEnter(chip, { pointerType: "mouse" });
    fireEvent.mouseEnter(chip);
    fireEvent.mouseMove(chip);
    vi.advanceTimersByTime(HOVER_DELAY_MS);
  });
}

function openCards(): readonly Element[] {
  return [...document.querySelectorAll(".meridian-cast-chip__card")];
}

function barWithTwoMembers(): HTMLElement {
  return renderBar(
    <CastBar
      sessionId={SESSION_ID}
      sessionStore={storeWith(
        ["participant-you", PARTICIPANT_PRIYA, AGENT_ARCHITECT],
        [admittedMember(1, PARTICIPANT_PRIYA, "priya"), attachedAgent(2, AGENT_ARCHITECT, "arch")],
      )}
      onFollow={() => undefined}
    />,
  );
}

describe("the cast bar's participant card", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows no card until a chip is pointed at", () => {
    barWithTwoMembers();

    expect(openCards()).toHaveLength(0);
  });

  it("opens one card, naming the chip that opened it", () => {
    const bar = barWithTwoMembers();

    pointAt(chipFor(bar, "priya"));

    expect(openCards()).toHaveLength(1);
    expect(openCards()[0]?.textContent).toContain("priya");
  });

  it("re-names the card when a second chip takes it over", () => {
    // The payload is read at open time and not remembered: pointing at a second chip
    // has to move the card onto that participant. A host that closed over the first
    // member would keep naming them while somebody pointed somewhere else.
    const bar = barWithTwoMembers();

    pointAt(chipFor(bar, "priya"));
    pointAt(chipFor(bar, "arch"));

    expect(openCards()).toHaveLength(1);
    expect(openCards()[0]?.textContent).toContain("arch");
  });
});
