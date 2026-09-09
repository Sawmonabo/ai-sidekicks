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
// The shell is driven through `FrameStore.publishShellReport`, the writer the shipped
// supervisor binding uses, so what closes these controls is the fold a real window runs.

import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { currentShellMutationBlock, type FrameStore } from "../../../store/index.js";
import { quietShell, stoppedShell } from "../../../store/shell-condition.test-support.js";
import { PAUSED, RUNNING, renderControls } from "./run-controls.test-support.js";

/** The sentence the block itself carries, read off the store rather than retyped. */
function blockSentence(frameStore: FrameStore): string {
  const block = currentShellMutationBlock(frameStore);
  if (block === undefined) {
    throw new Error("the stopped shell produced no block");
  }
  return block.detail;
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

    const stepIn = stepInButton(container);
    expect(stepIn.disabled).toBe(true);
    expect(stepIn.title).toBe(blockSentence(frameStore));
  });

  it("closes stop, which reaches the daemon through the intervention verb", () => {
    const frameStore = stoppedShell();

    const container = renderControls({ frameStore });

    const interrupt = controlButton(container, "interrupt");
    expect(interrupt.disabled).toBe(true);
    expect(interrupt.title).toBe(blockSentence(frameStore));
  });

  it("closes resume on a run at rest, which is the other control verb", () => {
    const frameStore = stoppedShell();

    const container = renderControls({ run: PAUSED, frameStore });

    const resume = controlButton(container, "resume");
    expect(resume.disabled).toBe(true);
    expect(resume.title).toBe(blockSentence(frameStore));
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
      const button = controlButton(container, control);
      expect(button.disabled).toBe(true);
      expect(button.title).toBe(blockSentence(frameStore));
    }
  });
});

describe("negative control: a serving supervisor closes nothing", () => {
  it("leaves every primary control open and carrying no reason", () => {
    const container = renderControls({ frameStore: quietShell() });

    expect(stepInButton(container).disabled).toBe(false);
    expect(stepInButton(container).title).toBe("");
    expect(controlButton(container, "interrupt").disabled).toBe(false);
    expect(controlButton(container, "interrupt").title).toBe("");
  });

  it("leaves the overflow half open too", () => {
    const container = renderControls({ frameStore: quietShell() });

    fireEvent.click(overflowToggle(container));

    for (const control of ["steer", "cancel", "rollback"]) {
      expect(controlButton(container, control).disabled).toBe(false);
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
