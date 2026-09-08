// What a stopped supervisor does to the four membership acts, and what it
// deliberately does NOT do to the rows beside them.
//
// `membership.update` is a write this console puts THROUGH the daemon rather than one
// that terminates in it, and `store/shell-mutation-block.ts` is where the console
// registers that it is a write at all. This suite is the consequence of that
// registration reaching the screen: every row's controls close while the runtime is
// not serving, the cause is said once above them, and the projected rows stay — an
// outage does not unproject a membership.
//
// The shell is driven through `FrameStore.publishShellReport`, the same writer the
// shipped supervisor binding uses, so what closes the controls here is the fold a real
// window runs rather than a state assembled by hand.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle } from "../../core/settle.test-support.js";
import type { FrameStore } from "../../store/index.js";
import { connectedShell, stoppedShell } from "../shell-condition.test-support.js";
import {
  Memberships,
  OWNER_AND_COLLABORATOR,
  contextFor,
  storeHolding,
} from "./Memberships.test-support.js";

/**
 * The section, with two rows and the shell in the condition under test.
 *
 * Settled before it is returned because the section renders the sent-invite ledger
 * below its own, and that ledger's one-shot read publishes after the render that
 * started it. Left unsettled, every case here would assert against a tree React was
 * still moving.
 */
async function renderUnder(frameStore: FrameStore): Promise<HTMLElement> {
  const { container } = render(
    <Memberships
      context={contextFor(storeHolding(OWNER_AND_COLLABORATOR), undefined, frameStore)}
    />,
  );
  await settle();
  return container;
}

/** Every row's manage trigger and revoke trigger. */
function rowControls(container: HTMLElement): readonly HTMLButtonElement[] {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      ".meridian-members__manage, .meridian-members__revoke",
    ),
  ];
}

/** Every refusal line on screen, as the code and sentence a person actually reads. */
function refusals(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-refusal--inline")].map(
    (refusal) => refusal.textContent ?? "",
  );
}

describe("memberships — a supervisor that is not serving", () => {
  it("closes every row's controls and names the cause once above them", async () => {
    const container = await renderUnder(stoppedShell());

    const controls = rowControls(container);
    expect(controls).toHaveLength(4);
    expect(controls.every((control) => control.disabled)).toBe(true);
    // Once for the ledger, not once per row: the cause is the window's, and two rows
    // would print the same words twice under a heading that already said them.
    expect(refusals(container)).toHaveLength(1);
    expect(refusals(container)[0] ?? "").toContain("shell-stopped");
    expect(refusals(container)[0] ?? "").toContain("The local runtime has been stopped");
  });

  it("carries the cause on the manage trigger as its own disabled reason", async () => {
    // The revoke control's trigger is the shared confirmation primitive, which
    // renders no tooltip of its own — so the sentence a person meets on hover is the
    // menu's, and the ledger's line is what covers the other control.
    const container = await renderUnder(stoppedShell());

    const manage = container.querySelector<HTMLButtonElement>(".meridian-members__manage");
    expect(manage?.getAttribute("title") ?? "").toContain("The local runtime has been stopped");
  });

  it("leaves the memberships it projected on screen", async () => {
    const container = await renderUnder(stoppedShell());

    expect(container.querySelectorAll(".meridian-members__row")).toHaveLength(2);
    expect(container.textContent ?? "").toContain("participant-priya");
  });

  it("negative control: a connected supervisor closes nothing and says nothing", async () => {
    // Without this, the cases above would pass over a ledger whose controls were
    // disabled unconditionally and which always printed a refusal.
    const container = await renderUnder(connectedShell());

    expect(rowControls(container).every((control) => !control.disabled)).toBe(true);
    expect(container.querySelector(".meridian-members__manage")?.getAttribute("title")).toBeNull();
    expect(refusals(container)).toStrictEqual([]);
  });
});
