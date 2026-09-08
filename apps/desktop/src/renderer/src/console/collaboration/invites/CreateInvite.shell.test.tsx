// The two moments a mint asks whether the supervisor will still take it.
//
// The form derives a block once per render, and that answer is what the control is
// drawn from. A press, though, is settled twice against a shell that may have moved
// since: once where the handler dispatches, and once inside the act itself — after the
// control-plane host read, which is a real await the supervisor can stop across.
//
// Both are the same question asked at the moment it matters rather than at the moment
// it was convenient, which is the rule `onboarding/provider-readiness/` already
// follows for its own re-check. The condition is driven through
// `FrameStore.publishShellReport`, the writer the shipped supervisor binding uses.

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { growthRefusing } from "../../bridge/fixture/fixture-bridge.test-support.js";
import { connectedShell, stopShell } from "../shell-condition.test-support.js";
import { CreateInvite } from "./CreateInvite.js";
import {
  MINTED_TOKEN,
  bridgeFor,
  heldHostRead,
  mintsReaching,
  pressSend,
  scenarioMinting,
  sendControl,
  settle,
} from "./create-invite.test-support.js";
import { SESSION_ID } from "./sent-invites.test-support.js";

/** The form over a bridge that records every call, with the shell under test. */
async function renderRecording(
  frameStore: ReturnType<typeof connectedShell>,
  overrides: Parameters<typeof bridgeFor>[1] = {},
): Promise<{
  readonly container: HTMLElement;
  readonly calls: readonly { readonly method: string }[];
  readonly onMinted: ReturnType<typeof vi.fn>;
}> {
  const { bridge, calls } = bridgeFor(scenarioMinting(), overrides);
  const onMinted = vi.fn();
  const { container } = render(
    <CreateInvite
      bridge={bridge}
      sessionId={SESSION_ID}
      onMinted={onMinted}
      frameStore={frameStore}
    />,
  );
  await settle();
  return { container, calls, onMinted };
}

describe("creating an invitation — a supervisor that stops between the render and the press", () => {
  it("mints nothing when the report landed after the render that offered the control", async () => {
    // The block the handler closed over is the one the last COMMITTED render derived.
    // A report landing after that render and before the press reaches the closure
    // leaves the guard reading `undefined` — so the control is still drawn open, the
    // press is admitted, and the whole act starts against a supervisor that has
    // stopped. The handler therefore re-reads the shell where it dispatches.
    const frameStore = connectedShell();
    const { container, calls, onMinted } = await renderRecording(frameStore);
    const send = sendControl(container);
    expect(send?.disabled).toBe(false);

    // Report and press inside ONE act, which is the order a press arriving on the
    // heels of a report actually takes: the store publishes, React has not re-rendered
    // yet, and the press reaches the handler the last committed render closed over.
    // The assertion sits inside for that reason — read after the act it would be the
    // re-rendered control, and the window this case is about would be invisible.
    act(() => {
      stopShell(frameStore);
      expect(send?.disabled).toBe(false);
      send?.click();
    });
    await settle();

    expect(mintsReaching(calls)).toBe(0);
    expect(onMinted).not.toHaveBeenCalled();
  });

  it("negative control: the same press does mint while the supervisor is serving", async () => {
    // Without this the case above would pass over a form whose send control minted
    // nothing under any condition.
    const { container, calls, onMinted } = await renderRecording(connectedShell());

    await pressSend(container);

    expect(mintsReaching(calls)).toBe(1);
    expect(onMinted).toHaveBeenCalledTimes(1);
  });
});

describe("creating an invitation — a supervisor that stops across the host read", () => {
  it("ends the act with nothing minted and keeps no refusal of its own", async () => {
    // The act reads the control-plane host BEFORE it mints, which is a real await: a
    // supervisor that stops while that read is out was serving when the press was
    // admitted and is not serving when the mint would go out. Guarded only at the
    // press, `invite.create` reaches a stopped runtime; re-read after the read, the act
    // ends where the host refusal would have ended it — nothing created, and pressing
    // again the whole retry. What it does NOT leave is a refusal line of its own: the
    // reason is the shell's, said once by the hosting section and carried on the
    // control as its disabled reason, and a copy here would outlive the outage.
    // `Memberships.shell.test.tsx` holds the section's sentence and the recovery.
    const frameStore = connectedShell();
    const host = heldHostRead();
    const { container, calls, onMinted } = await renderRecording(frameStore, {
      controlPlaneHostRead: host.read,
    });

    await pressSend(container);
    expect(sendControl(container)?.disabled).toBe(true);

    act(() => {
      stopShell(frameStore);
    });
    host.answer();
    await settle();

    expect(mintsReaching(calls)).toBe(0);
    expect(onMinted).not.toHaveBeenCalled();
    const send = sendControl(container);
    expect(send?.disabled).toBe(true);
    expect(send?.getAttribute("title") ?? "").toContain("The local runtime has been stopped");
    expect(container.querySelector(".meridian-refusal--inline")).toBeNull();
    expect(container.querySelector(".meridian-invite-create__refusal-dismiss")).toBeNull();
    expect(container.textContent ?? "").not.toContain(MINTED_TOKEN);
  });

  it("negative control: a refusal that is the press's own does stand on the form", async () => {
    // Without this the case above would pass over a form that rendered no refusal
    // under any condition. A host that cannot be read is this press's outcome and
    // nobody else's sentence, so it stands beside the control with its dismissal.
    const { container, calls } = await renderRecording(connectedShell(), {
      controlPlaneHostRead: growthRefusing("controlPlaneHostRead"),
    });

    await pressSend(container);

    expect(mintsReaching(calls)).toBe(0);
    expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();
    expect(container.querySelector(".meridian-invite-create__refusal-dismiss")).not.toBeNull();
  });

  it("negative control: the same read answered under a serving supervisor mints once", async () => {
    // Without this the case above would pass over a form that never minted behind a
    // held read at all, which is a broken act rather than a guarded one.
    const host = heldHostRead();
    const { container, calls } = await renderRecording(connectedShell(), {
      controlPlaneHostRead: host.read,
    });

    await pressSend(container);
    host.answer();
    await settle();

    expect(mintsReaching(calls)).toBe(1);
    expect(container.textContent ?? "").toContain(MINTED_TOKEN);
  });
});
