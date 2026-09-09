// What a stopped supervisor does to the run controls, and what it deliberately leaves
// alone.
//
// Every one of the six reaches the daemon through a method the block closes — `run.pause`,
// `run.resume`, or the four-armed `run.intervene` — so under an outage none of them can
// land. `callDaemon` already refuses each one at the door, which is what makes a press
// harmless; this suite is about the half a person sees BEFORE they press, which is that
// the control does not invite one and says why it cannot.
//
// DISABLED AND NOT ABSENT, WHICH IS THE OPPOSITE OF THE CAPABILITY RULE NEXT DOOR. A
// control the driver never declared is off screen, because a disabled one would assert
// the capability exists and is momentarily unavailable. Here that assertion is exactly
// true: the control exists, the runtime is down, and the person can bring it back — so
// withdrawing it would hide an act that is one banner press away from working again.
//
// AND CLOSED MEANS `aria-disabled` PLUS A SENTENCE ON SCREEN, never `disabled` plus a
// `title`. A `disabled` button leaves the tab order and its tooltip is announced by
// nothing, so the reason was reachable by hover alone; these cases assert the shape
// `ControlButton.tsx` settled on instead — the button stays focusable, points at the
// row's one sentence through `aria-describedby`, and runs nothing when pressed.
//
// The shell is driven through `FrameStore.publishShellReport`, the writer the shipped
// supervisor binding uses, so what closes these controls is the fold a real window runs.

import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { currentShellMutationBlock, type FrameStore } from "../../../store/index.js";
import { quietShell, stoppedShell } from "../../../store/shell-condition.test-support.js";
import type { RunControlSurface } from "./run-control-surface.js";
import { PAUSED, RUNNING, renderControls, surfaceHolding } from "./run-controls.test-support.js";

/** The sentence the block itself carries, read off the store rather than retyped. */
function blockSentence(frameStore: FrameStore): string {
  const block = currentShellMutationBlock(frameStore);
  if (block === undefined) {
    throw new Error("the stopped shell produced no block");
  }
  return block.detail;
}

/** The row's one closing sentence, or `undefined` where the row rendered none. */
function closingSentence(container: HTMLElement): string | undefined {
  return container.querySelector(".meridian-run-controls__closed")?.textContent ?? undefined;
}

/** Whether a control is closed, and whether it points at the sentence that closed it. */
function closedState(
  container: HTMLElement,
  button: HTMLButtonElement,
): { readonly closed: string | null; readonly describes: string | undefined } {
  const describedBy = button.getAttribute("aria-describedby");
  const described =
    describedBy === null
      ? undefined
      : (container.querySelector(`#${CSS.escape(describedBy)}`)?.textContent ?? undefined);
  return { closed: button.getAttribute("aria-disabled"), describes: described };
}

/** One control's button, by the class the strip gives it. */
function controlButton(container: HTMLElement, control: string): HTMLButtonElement {
  const found = container.querySelector(`.meridian-run-controls__action--${control}`);
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`the strip rendered no ${control} control`);
  }
  return found;
}

/** The step-in button, which is the pause verb's own control. */
function stepInButton(container: HTMLElement): HTMLButtonElement {
  const found = container.querySelector(".meridian-step-in__action");
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error("the strip rendered no step-in control");
  }
  return found;
}

/** The disclosure that opens the one-click-away half. */
function overflowToggle(container: HTMLElement): HTMLButtonElement {
  const found = container.querySelector(".meridian-run-controls__overflow-toggle");
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error("the strip rendered no overflow toggle");
  }
  return found;
}

describe("the primary controls under a stopped supervisor", () => {
  it("closes step in — the pause verb — and says why", () => {
    const frameStore = stoppedShell();

    const container = renderControls({ frameStore });

    const state = closedState(container, stepInButton(container));
    expect(state.closed).toBe("true");
    expect(state.describes).toBe(blockSentence(frameStore));
  });

  it("closes stop, which reaches the daemon through the intervention verb", () => {
    const frameStore = stoppedShell();

    const container = renderControls({ frameStore });

    const state = closedState(container, controlButton(container, "interrupt"));
    expect(state.closed).toBe("true");
    expect(state.describes).toBe(blockSentence(frameStore));
  });

  it("closes resume on a run at rest, which is the other control verb", () => {
    const frameStore = stoppedShell();

    const container = renderControls({ run: PAUSED, frameStore });

    const state = closedState(container, controlButton(container, "resume"));
    expect(state.closed).toBe("true");
    expect(state.describes).toBe(blockSentence(frameStore));
  });

  it("says it once for the whole row, however many controls it closed", () => {
    const frameStore = stoppedShell();

    const container = renderControls({ frameStore });

    // One condition closed every control in the row, so the row states it once. Six
    // copies of one sentence would be six announcements of a single outage.
    expect(container.querySelectorAll(".meridian-run-controls__closed")).toHaveLength(1);
    expect(closingSentence(container)).toBe(blockSentence(frameStore));
  });
});

describe("a closed control runs nothing when it is pressed", () => {
  it("puts no dispatch on the wire", () => {
    const dispatched: string[] = [];
    const surface = surfaceHolding([]);

    const container = renderControls({
      run: PAUSED,
      frameStore: stoppedShell(),
      surface: {
        ...surface,
        dispatch: (runId: string, control: string) => {
          dispatched.push(`${runId}:${control}`);
          return { admitted: true, dispatchToken: "token" };
        },
      } as RunControlSurface,
    });

    fireEvent.click(controlButton(container, "resume"));

    // `aria-disabled` stops nothing on its own, so the button guards its own press.
    // The door would refuse this one anyway; the two controls below it would not be
    // refused by anything, because they put no call at all.
    expect(dispatched).toStrictEqual([]);
  });

  it("opens no composer for the two controls that only compose", () => {
    let rewindsRequested = 0;
    let steersRequested = 0;

    const container = renderControls({
      frameStore: stoppedShell(),
      onRequestRewind: () => {
        rewindsRequested += 1;
      },
      onRequestSteer: () => {
        steersRequested += 1;
      },
    });
    fireEvent.click(overflowToggle(container));
    fireEvent.click(controlButton(container, "rollback"));
    fireEvent.click(controlButton(container, "steer"));

    // THE CASE THE DOOR CANNOT COVER. Steer and rewind put no daemon call — they open a
    // composer whose CONFIRM does — so nothing downstream would have refused these two
    // presses, and a person would have written a message the console could not send.
    expect(rewindsRequested).toBe(0);
    expect(steersRequested).toBe(0);
  });
});

describe("the overflow half under a stopped supervisor", () => {
  it("still discloses, because reading what is offered sends nothing", () => {
    const frameStore = stoppedShell();

    const container = renderControls({ frameStore });

    const toggle = overflowToggle(container);
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    expect(container.querySelector(".meridian-run-controls__overflow")).not.toBeNull();
  });

  it("closes each of the three it discloses, every one of them with the same reason", () => {
    const frameStore = stoppedShell();
    const container = renderControls({ frameStore });

    fireEvent.click(overflowToggle(container));

    // Steer and rewind only OPEN a composer, and they are closed all the same: what
    // that composer confirms is `run.intervene`, so offering the compose would invite
    // a person to write a message the console cannot send.
    for (const control of ["steer", "cancel", "rollback"]) {
      const state = closedState(container, controlButton(container, control));
      expect(state.closed).toBe("true");
      expect(state.describes).toBe(blockSentence(frameStore));
    }
  });
});

describe("negative control: a serving supervisor closes nothing", () => {
  it("leaves every primary control open and carrying no reason", () => {
    const container = renderControls({ frameStore: quietShell() });

    expect(stepInButton(container).getAttribute("aria-disabled")).toBe("false");
    expect(controlButton(container, "interrupt").getAttribute("aria-disabled")).toBe("false");
    // The negative control that makes the four cases above non-vacuous: with nothing
    // closing the row there is no sentence to point at, and no control points at one.
    expect(closingSentence(container)).toBeUndefined();
    expect(stepInButton(container).getAttribute("aria-describedby")).toBeNull();
  });

  it("leaves the overflow half open too", () => {
    const container = renderControls({ frameStore: quietShell() });

    fireEvent.click(overflowToggle(container));

    for (const control of ["steer", "cancel", "rollback"]) {
      expect(controlButton(container, control).getAttribute("aria-disabled")).toBe("false");
    }
  });

  it("offers the same controls under both conditions — closed is never withdrawn", () => {
    const serving = renderControls({ run: RUNNING, frameStore: quietShell() });
    const stopped = renderControls({ run: RUNNING, frameStore: stoppedShell() });

    fireEvent.click(overflowToggle(serving));
    fireEvent.click(overflowToggle(stopped));

    const named = (container: HTMLElement): readonly string[] =>
      [...container.querySelectorAll("button")].map((button) => button.className);
    expect(named(stopped)).toStrictEqual(named(serving));
  });
});
