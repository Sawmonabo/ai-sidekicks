// A settlement belongs to the press that produced it, and closing does not take it back.
//
// WHAT THESE CASES PIN. The confirm control is an `AlertDialog.Close`, so it sends and
// closes in one act. A discard wired to every close therefore fires immediately after
// `send()` published `sending`: the card falls back to idle, the trigger that state had
// disabled re-enables under a call still on the wire, and a second press reaches the
// controller's single-flight guard and returns silently. The first case fails against that
// wiring on both observables, the state and the trigger.
//
// THE POPUP IS PORTALLED, so every press below is read off `document` rather than the
// render container: the trigger and the settlement are on the card, and the two acts
// are in a popup attached to the body.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
import { scriptedRepoOperations } from "../../repo-operations.test-support.js";
import type { RepoOperations } from "../../repo-operations.js";
import { RootRemovalConfirmation } from "./RootRemovalConfirmation.js";

/** A canonical UUID, so `repo.worktreeRetire` is a request the binding will send. */
const WORKTREE_ID = "019b79ee-0280-740e-8110-d1a4c1150091";

/** A daemon whose removal call never answers, so the sent state stays observable. */
function daemonHoldingTheCall(): RepoOperations {
  return scriptedRepoOperations({
    retireWorktree: async () => await new Promise<never>(() => undefined),
  });
}

/** A daemon that records the removal, so a settlement lands on the card. */
function daemonAnsweringTheCall(): RepoOperations {
  return scriptedRepoOperations({
    retireWorktree: (worktreeId) => Promise.resolve({ worktreeId, state: "retired" }),
  });
}

function renderConfirmation(operations: RepoOperations): ReturnType<typeof render> {
  return render(
    <RootRemovalConfirmation
      bridge={bridgeOnClock("repos").bridge}
      operations={operations}
      rootId={WORKTREE_ID}
      onSettled={() => undefined}
    />,
  );
}

/** The card's own trigger, which the sent state disables. */
function trigger(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(".meridian-root-removal__trigger");
}

async function pressOpen(): Promise<void> {
  await act(async () => {
    trigger()?.click();
  });
}

async function pressConfirm(): Promise<void> {
  await act(async () => {
    document.querySelector<HTMLButtonElement>(".meridian-root-removal__confirm")?.click();
  });
}

async function pressCancel(): Promise<void> {
  await act(async () => {
    document.querySelector<HTMLButtonElement>(".meridian-root-removal__cancel")?.click();
  });
}

describe("RootRemovalConfirmation — the confirm press keeps its settlement", () => {
  it("still reports the removal as sent once the confirm control has closed the dialog", async () => {
    const { container } = renderConfirmation(daemonHoldingTheCall());

    await pressOpen();
    await pressConfirm();

    expect(container.textContent).toContain("Sending.");
    expect(trigger()?.disabled).toBe(true);
  });

  it("negative control: with nothing pressed the card carries no settlement and the trigger is live", async () => {
    // Without this the case above would pass against a card that always said
    // `Sending.` and always held its trigger, which is a removal nobody can start.
    const { container } = renderConfirmation(daemonHoldingTheCall());

    await pressOpen();

    expect(container.textContent).not.toContain("Sending.");
    expect(trigger()?.disabled).toBe(false);
  });
});

describe("RootRemovalConfirmation — a discarded consideration", () => {
  it("discards the standing settlement when the user walks away from the question", async () => {
    const { container } = renderConfirmation(daemonAnsweringTheCall());

    await pressOpen();
    await pressConfirm();
    expect(container.querySelector(".meridian-root-removal__settled")).not.toBeNull();

    await pressOpen();
    await pressCancel();

    expect(container.querySelector(".meridian-root-removal__settled")).toBeNull();
  });

  it("negative control: a settlement nobody reconsidered stays on the card", async () => {
    // The record of a removal is what a person acts on next. A card that cleared it on
    // any close would erase it before it could be read.
    const { container } = renderConfirmation(daemonAnsweringTheCall());

    await pressOpen();
    await pressConfirm();

    expect(container.querySelector(".meridian-root-removal__settled")).not.toBeNull();
  });
});
