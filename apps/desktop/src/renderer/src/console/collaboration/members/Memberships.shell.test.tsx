// What a stopped supervisor does to the four membership acts, and what it
// deliberately does NOT do to the rows beside them.
//
// `membership.update` is a write this console puts THROUGH the daemon rather than one
// that terminates in it, and `store/shell/shell-mutation-block.ts` is where the console
// registers that it is a write at all. This suite is the consequence of that
// registration reaching the screen: every row's controls close while the runtime is
// not serving, the cause is said once above everything under the heading, and the
// projected rows stay — an outage does not unproject a membership.
//
// The shell is driven through `FrameStore.publishShellReport`, the same writer the
// shipped supervisor binding uses, so what closes the controls here is the fold a real
// window runs rather than a state assembled by hand.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  unscriptedScenario,
  withDaemonCall,
  type RecordedDaemonCall,
} from "../../bridge/fixture/call-plane/bridge.test-support.js";
import { createFixtureBridge } from "../../bridge/index.js";
import { settle } from "../../core/settle.test-support.js";
import type { FrameStore } from "../../store/index.js";
import {
  MINTED_TOKEN,
  bridgeFor,
  heldHostRead,
  mintsReaching,
  pressSend,
  scenarioMinting,
  sendControl,
} from "../invites/create-invite.test-support.js";
import {
  connectedShell,
  serveShell,
  stopShell,
  stoppedShell,
} from "../shell-condition.test-support.js";
import {
  Memberships,
  OWNER_AND_COLLABORATOR,
  type ProjectedMembership,
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
async function renderUnder(
  frameStore: FrameStore,
  memberships: readonly ProjectedMembership[] = OWNER_AND_COLLABORATOR,
): Promise<HTMLElement> {
  const { container } = render(
    <Memberships context={contextFor(storeHolding(memberships), undefined, frameStore)} />,
  );
  await settle();
  return container;
}

/**
 * The same section over a bridge that records every call the console puts.
 *
 * The record is what a dispatch-time case reads: a change suppressed at the handler
 * and one refused by the daemon look identical on screen, and only the wire says which
 * happened.
 */
async function renderRecording(frameStore: FrameStore): Promise<{
  readonly container: HTMLElement;
  readonly calls: readonly RecordedDaemonCall[];
}> {
  const { bridge, calls } = withDaemonCall(
    createFixtureBridge({ scenario: unscriptedScenario("collaboration-members-shell-test") }),
    async (_recorded, passThrough) => await passThrough(),
  );
  const { container } = render(
    <Memberships context={contextFor(storeHolding(OWNER_AND_COLLABORATOR), bridge, frameStore)} />,
  );
  await settle();
  return { container, calls };
}

/** How many membership changes actually reached the daemon. */
function updatesReaching(calls: readonly RecordedDaemonCall[]): number {
  return calls.filter((recorded) => recorded.method === "membership.update").length;
}

/** The first row's revoke trigger — the control a confirmation opens behind. */
function revokeTrigger(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(".meridian-members__revoke");
}

/** The confirmation's own act, which lives in the window's airspace and not in the row. */
function confirmControl(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(".meridian-confirm__confirm");
}

/** Every row's manage trigger and revoke trigger. */
function rowControls(container: HTMLElement): readonly HTMLButtonElement[] {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      ".meridian-members__manage, .meridian-members__revoke",
    ),
  ];
}

/**
 * Every refusal line naming the SHELL, as the code and sentence a person actually reads.
 *
 * Filtered to the shell's own codes because the section hosts the invitation mint,
 * which says its own, different refusal when the caller's identity read is not
 * registered on the build — a line with another owner and another cause, and the
 * claim here is about how many times THIS cause is said.
 */
function shellRefusals(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-refusal--inline")]
    .map((refusal) => refusal.textContent ?? "")
    .filter((line) => line.includes("shell-"));
}

describe("memberships — a supervisor that is not serving", () => {
  it("closes every row's controls and names the cause once for the section", async () => {
    const container = await renderUnder(stoppedShell());

    const controls = rowControls(container);
    expect(controls).toHaveLength(4);
    expect(controls.every((control) => control.disabled)).toBe(true);
    // Once for the SECTION, not once per row and not once per ledger: the cause is the
    // window's, and the sent-invite ledger this section hosts below would otherwise
    // print the same words a second time under a heading that already said them.
    expect(shellRefusals(container)).toHaveLength(1);
    expect(shellRefusals(container)[0] ?? "").toContain("shell-stopped");
    expect(shellRefusals(container)[0] ?? "").toContain("The local runtime has been stopped");
  });

  it("carries the cause on the manage trigger as its own disabled reason", async () => {
    // The revoke control's trigger is the shared confirmation primitive, which
    // renders no tooltip of its own — so the sentence a person meets on hover is the
    // menu's, and the section's line is what covers the other control.
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
    expect(shellRefusals(container)).toStrictEqual([]);
  });

  it("says the cause once for the section even with no membership read", async () => {
    // The sentence belongs to the SECTION and not to the row list, and this is the
    // case that decides where it lives: with no row to print, a ledger that owned the
    // sentence returned its empty state before saying anything, so the invitation
    // controls this section hosts stood disabled under a heading that named no cause.
    const container = await renderUnder(stoppedShell(), []);

    expect(container.textContent ?? "").toContain("No membership has been read");
    expect(shellRefusals(container)).toHaveLength(1);
    expect(shellRefusals(container)[0] ?? "").toContain("shell-stopped");
    const send = container.querySelector<HTMLButtonElement>(".meridian-invite-create__send");
    expect(send?.disabled).toBe(true);
    expect(send?.getAttribute("title") ?? "").toContain("The local runtime has been stopped");
  });

  it("negative control: an empty ledger under a serving supervisor says nothing", async () => {
    // Without this the case above would pass over a section that printed a shell
    // refusal above every empty ledger, whatever the supervisor had reported.
    const container = await renderUnder(connectedShell(), []);

    expect(container.textContent ?? "").toContain("No membership has been read");
    expect(shellRefusals(container)).toStrictEqual([]);
  });
});

describe("memberships — a supervisor that stops between the render and the press", () => {
  it("puts no membership change when the report landed after the render", async () => {
    // The block the handler closed over is the one the last COMMITTED render derived.
    // A report landing after that render and before the press reaches the closure
    // leaves the guard reading `undefined` — so the confirmation is still open, the
    // press is admitted, and `membership.update` goes out through a supervisor that has
    // stopped. The handler therefore re-reads the shell where it dispatches.
    const frameStore = connectedShell();
    const { container, calls } = await renderRecording(frameStore);
    act(() => {
      revokeTrigger(container)?.click();
    });
    expect(confirmControl()).not.toBeNull();

    // Report and press inside ONE act, which is the order a press arriving on the heels
    // of a report actually takes: the store publishes, React has not re-rendered yet,
    // and the press reaches the handler the last committed render closed over. The
    // assertion sits inside for that reason — read after the act it would be the
    // re-rendered trigger, and the window this case is about would be invisible.
    act(() => {
      stopShell(frameStore);
      expect(revokeTrigger(container)?.disabled).toBe(false);
      confirmControl()?.click();
    });
    await settle();

    expect(updatesReaching(calls)).toBe(0);
  });

  it("negative control: the same press does reach the daemon while it is serving", async () => {
    // Without this the case above would pass over a section whose confirmation
    // dispatched nothing under any condition.
    const { container, calls } = await renderRecording(connectedShell());
    act(() => {
      revokeTrigger(container)?.click();
    });
    act(() => {
      confirmControl()?.click();
    });
    await settle();

    expect(updatesReaching(calls)).toBe(1);
  });
});

describe("memberships — a supervisor that stops across the invitation's host read, then serves again", () => {
  it("says the cause once through the outage and leaves nothing behind once it is over", async () => {
    // The invitation mint reads the control-plane host before it mints — a real await
    // the supervisor can stop across — and the act's own re-check ends the press there.
    // What this hierarchy holds is what that abort LEAVES. Through the outage the one
    // shell sentence is this section's, and the form prints no refusal of its own under
    // the same heading; once the runtime serves again the sentence goes, the send
    // control re-opens, and the next press mints — because the shell's condition was
    // never recorded on the form as a refusal that could outlive it.
    const frameStore = connectedShell();
    const host = heldHostRead();
    const { bridge, calls } = bridgeFor(scenarioMinting(), { controlPlaneHostRead: host.read });
    const { container } = render(
      <Memberships
        context={contextFor(storeHolding(OWNER_AND_COLLABORATOR), bridge, frameStore)}
      />,
    );
    await settle();

    await pressSend(container);
    act(() => {
      stopShell(frameStore);
    });
    host.answer();
    await settle();

    expect(mintsReaching(calls)).toBe(0);
    expect(shellRefusals(container)).toHaveLength(1);
    expect(container.querySelector(".meridian-invite-create__refusal-dismiss")).toBeNull();
    expect(sendControl(container)?.disabled).toBe(true);

    act(() => {
      serveShell(frameStore);
    });
    await settle();

    expect(shellRefusals(container)).toStrictEqual([]);
    expect(sendControl(container)?.disabled).toBe(false);

    await pressSend(container);

    expect(mintsReaching(calls)).toBe(1);
    expect(container.textContent ?? "").toContain(MINTED_TOKEN);
  });
});
