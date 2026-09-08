// What a stopped supervisor does to the revoke control, and what it deliberately
// does NOT do to the ledger beside it.
//
// `invite.revoke` is a write this console puts THROUGH the daemon rather than one
// that terminates in it, and `store/shell-mutation-block.ts` is where the console
// registers that it is a write at all. This suite is the consequence of that
// registration reaching the screen: the control closes while the runtime is not
// serving, it says why, and the rows above it — an answer this window already has —
// stay exactly as they were, because an outage does not make a read untrue.
//
// The shell is driven through `FrameStore.publishShellReport`, the same writer the
// shipped supervisor binding uses, so what closes the control here is the fold a real
// window runs rather than a state assembled by hand.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { FrameStore } from "../../store/index.js";
import { connectedShell, stoppedShell } from "../shell-condition.test-support.js";
import { SentInvites } from "./SentInvites.js";
import {
  INVITE_1,
  SESSION_ID,
  bridgeServing,
  invite,
  settle,
} from "./sent-invites.test-support.js";

/** The surface, with one pending row and the shell in the condition under test. */
async function renderUnder(frameStore: FrameStore): Promise<HTMLElement> {
  const { container } = render(
    <SentInvites
      bridge={bridgeServing([invite({ inviteId: INVITE_1 })])}
      sessionId={SESSION_ID}
      frameStore={frameStore}
    />,
  );
  await settle();
  return container;
}

/** The one revoke control the pending row draws. */
function revokeControl(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(".meridian-invites__row-action");
}

/** Every refusal line on screen, as the code and sentence a person actually reads. */
function refusals(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-refusal--inline")].map(
    (refusal) => refusal.textContent ?? "",
  );
}

describe("sent invites — a supervisor that is not serving", () => {
  it("closes the revoke control and carries the cause on it", async () => {
    const container = await renderUnder(stoppedShell());

    const revoke = revokeControl(container);
    expect(revoke?.disabled).toBe(true);
    // The cause reaches the control as its own disabled reason — half of "disabled
    // with its cause beside it". The other half, the one SENTENCE naming the cause, is
    // the hosting members section's, said once above its rows for every control under
    // its heading; this surface prints no second copy, which is what the count below
    // holds. `Memberships.shell.test.tsx` holds the sentence itself.
    expect(revoke?.getAttribute("title") ?? "").toContain("The local runtime has been stopped");
    expect(refusals(container).filter((line) => line.includes("shell-"))).toStrictEqual([]);
  });

  it("leaves the ledger it already read on screen", async () => {
    // The block is scoped to the CONTROL. The row below it is an answer this window
    // received before the runtime went away, and hiding it would report the outage as
    // a session with no invitations in it.
    const container = await renderUnder(stoppedShell());

    expect(container.querySelectorAll(".meridian-invites__row")).toHaveLength(1);
    expect(container.textContent ?? "").toContain(INVITE_1);
  });

  it("negative control: a connected supervisor closes nothing and says nothing", async () => {
    // Without this, both cases above would pass over a surface whose revoke control
    // was disabled unconditionally and whose ledger always printed a refusal.
    const container = await renderUnder(connectedShell());

    expect(revokeControl(container)?.disabled).toBe(false);
    expect(revokeControl(container)?.getAttribute("title")).toBeNull();
    expect(refusals(container)).toStrictEqual([]);
  });
});
