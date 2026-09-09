// A settlement belongs to the press that produced it, and closing does not take it back.
//
// WHAT THESE CASES PIN. The confirm control is an `AlertDialog.Close`, so it sends and
// closes in one act. A discard wired to every close therefore fires immediately after
// `send()` published `sending`: the card falls back to idle, the trigger that state had
// disabled re-enables under a call still on the wire, and a second press reaches the
// controller's single-flight guard and returns silently — a disposal a person pressed
// twice and was told nothing about either time. The first case fails against that
// wiring on both observables, the state and the trigger.
//
// THE POPUP IS PORTALLED, so every press below is read off `document` rather than the
// render container: the trigger and the settlement are on the card, and the two acts
// are in a popup attached to the body.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../../../bridge/index.js";
import {
  fixtureBridgeWithGrowth,
  withDaemonCall,
} from "../../../bridge/fixture/call-plane/bridge.test-support.js";
import { REPOS_SCENARIO } from "../../../bridge/scenarios/repos.js";
import { RootDisposalConfirmation } from "./RootDisposalConfirmation.js";
import { quietShell } from "../../../store/shell-condition.test-support.js";

/** A canonical UUID, so `repo.worktreeRetire` is a request the binding will send. */
const WORKTREE_ID = "019b79ee-0280-740e-8110-d1a4c1150091";

/** A bridge whose disposal call never answers, so the sent state stays observable. */
function bridgeHoldingTheCall(): ConsoleBridge {
  return withDaemonCall(
    fixtureBridgeWithGrowth(REPOS_SCENARIO, {}),
    async () => await new Promise<never>(() => undefined),
  ).bridge;
}

/** A bridge whose disposal call is rejected, so a settlement lands on the card. */
function bridgeRefusingTheCall(): ConsoleBridge {
  return withDaemonCall(fixtureBridgeWithGrowth(REPOS_SCENARIO, {}), async () => {
    throw new Error("the daemon closed the connection");
  }).bridge;
}

function renderConfirmation(bridge: ConsoleBridge): ReturnType<typeof render> {
  return render(
    <RootDisposalConfirmation
      bridge={bridge}
      kind="worktree"
      rootId={WORKTREE_ID}
      frameStore={quietShell()}
      onSettled={() => undefined}
    />,
  );
}

/** The card's own trigger, which the sent state disables. */
function trigger(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(".meridian-root-disposal__trigger");
}

async function pressOpen(): Promise<void> {
  await act(async () => {
    trigger()?.click();
  });
}

async function pressConfirm(): Promise<void> {
  await act(async () => {
    document.querySelector<HTMLButtonElement>(".meridian-root-disposal__confirm")?.click();
  });
}

async function pressCancel(): Promise<void> {
  await act(async () => {
    document.querySelector<HTMLButtonElement>(".meridian-root-disposal__cancel")?.click();
  });
}

describe("RootDisposalConfirmation — the confirm press keeps its settlement", () => {
  it("still reports the disposal as sent once the confirm control has closed the dialog", async () => {
    const { container } = renderConfirmation(bridgeHoldingTheCall());

    await pressOpen();
    await pressConfirm();

    expect(container.textContent).toContain("Sending.");
    expect(trigger()?.disabled).toBe(true);
  });

  it("negative control: with nothing pressed the card carries no settlement and the trigger is live", async () => {
    // Without this the case above would pass against a card that always said
    // `Sending.` and always held its trigger, which is a disposal nobody can start.
    const { container } = renderConfirmation(bridgeHoldingTheCall());

    await pressOpen();

    expect(container.textContent).not.toContain("Sending.");
    expect(trigger()?.disabled).toBe(false);
  });
});

describe("RootDisposalConfirmation — a discarded consideration", () => {
  it("discards the standing settlement when the participant walks away from the question", async () => {
    const { container } = renderConfirmation(bridgeRefusingTheCall());

    await pressOpen();
    await pressConfirm();
    expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();

    await pressOpen();
    await pressCancel();

    expect(container.querySelector(".meridian-refusal--inline")).toBeNull();
  });

  it("negative control: a settlement nobody reconsidered stays on the card", async () => {
    // The record of a refused disposal is what a person acts on next. A card that
    // cleared it on any close would erase the reason before it could be read.
    const { container } = renderConfirmation(bridgeRefusingTheCall());

    await pressOpen();
    await pressConfirm();

    expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();
  });
});
