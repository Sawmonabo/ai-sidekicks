// The re-attach a person pressed goes on being reported after the dialog shuts.
//
// THE SAME DEFECT AS `roots/RootDisposalConfirmation.test.tsx` PINS, on the family's
// other alert dialog. The confirm control is an `AlertDialog.Close`, so it sends and
// closes in one act; a discard wired to every close fires straight after `attach()`
// published `sending`, and the card falls back to idle with its trigger live again
// under a `repo.attach` still on the wire. The second press then reaches the act
// controller's single-flight guard and returns silently, so a person who pressed twice
// is told nothing either time — while the mount the first call mints appears anyway.
//
// THE POPUP IS PORTALLED, so the acts are read off `document` and the settlement off
// the render container, which is where this control draws it: on the card, beside the
// verdict it is about.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../../../bridge/index.js";
import {
  fixtureBridgeWithGrowth,
  withDaemonCall,
} from "../../../bridge/fixture/call-plane/bridge.test-support.js";
import { REPOS_SCENARIO } from "../../../bridge/scenarios/repos.js";
import { SessionStore } from "../../../store/index.js";
import { ReattachControl } from "./ReattachControl.js";
import { quietShell } from "../../../store/shell-condition.test-support.js";

/** A canonical UUID, so `repo.attach` is a request the daemon binding will send. */
const SESSION_ID = "019b79ee-0280-740e-8110-d1a4c1150091";

const LOCAL_PATH = "/Users/dev/code/ai-sidekicks/packages/contracts";
const NODE_ID = "node-laptop";

/** A bridge whose attach never answers, so the sent state stays observable. */
function bridgeHoldingTheCall(): ConsoleBridge {
  return withDaemonCall(
    fixtureBridgeWithGrowth(REPOS_SCENARIO, {}),
    async () => await new Promise<never>(() => undefined),
  ).bridge;
}

/** A bridge whose attach is rejected, so a settlement lands on the card. */
function bridgeRefusingTheCall(): ConsoleBridge {
  return withDaemonCall(fixtureBridgeWithGrowth(REPOS_SCENARIO, {}), async () => {
    throw new Error("the daemon closed the connection");
  }).bridge;
}

function renderControl(bridge: ConsoleBridge): ReturnType<typeof render> {
  return render(
    <ReattachControl
      bridge={bridge}
      sessionStore={new SessionStore({ sessionId: SESSION_ID })}
      frameStore={quietShell()}
      localPath={LOCAL_PATH}
      nodeId={NODE_ID}
      onAttached={() => undefined}
    />,
  );
}

/** The card's own trigger, which the sent state disables. */
function trigger(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(".meridian-reattach__trigger");
}

async function pressOpen(): Promise<void> {
  await act(async () => {
    trigger()?.click();
  });
}

async function pressConfirm(): Promise<void> {
  await act(async () => {
    document.querySelector<HTMLButtonElement>(".meridian-reattach__confirm")?.click();
  });
}

async function pressCancel(): Promise<void> {
  await act(async () => {
    document.querySelector<HTMLButtonElement>(".meridian-reattach__cancel")?.click();
  });
}

describe("ReattachControl — the confirm press keeps its settlement", () => {
  it("still reports the re-attach as sent once the confirm control has closed the dialog", async () => {
    const { container } = renderControl(bridgeHoldingTheCall());

    await pressOpen();
    await pressConfirm();

    expect(container.textContent).toContain("Re-attaching.");
    expect(trigger()?.disabled).toBe(true);
  });

  it("negative control: with nothing pressed the card carries no settlement and the trigger is live", async () => {
    // Without this the case above would pass against a card that always said
    // `Re-attaching.` and always held its trigger, which is a remedy nobody can reach.
    const { container } = renderControl(bridgeHoldingTheCall());

    await pressOpen();

    expect(container.textContent).not.toContain("Re-attaching.");
    expect(trigger()?.disabled).toBe(false);
  });
});

describe("ReattachControl — a discarded consideration", () => {
  it("discards the standing settlement when the participant walks away from the question", async () => {
    const { container } = renderControl(bridgeRefusingTheCall());

    await pressOpen();
    await pressConfirm();
    expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();

    await pressOpen();
    await pressCancel();

    expect(container.querySelector(".meridian-refusal--inline")).toBeNull();
  });

  it("negative control: a settlement nobody reconsidered stays on the card", async () => {
    // A refused re-attach is the only place its reason is written. Cleared on any
    // close, it would be gone before the person who pressed could read it.
    const { container } = renderControl(bridgeRefusingTheCall());

    await pressOpen();
    await pressConfirm();

    expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();
  });
});
