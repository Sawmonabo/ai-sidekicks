// A settlement belongs to the press that produced it, and closing does not take it back. The
// confirm is an `AlertDialog.Close`, so it sends and closes in one act; a discard wired to every
// close would fire right after `send()` published `sending`, idling the card and re-enabling the
// trigger under a call still on the wire. The popup is portalled, so presses are read off
// `document`.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
import { scriptedRepoOperations } from "../../repo-operations.test-support.js";
import type { RepoOperations } from "../../repo-operations.js";
import { RootRemovalConfirmation } from "./RootRemovalConfirmation.js";

const WORKTREE_ID = "019b79ee-0280-740e-8110-d1a4c1150091";

function daemonHoldingTheCall(): RepoOperations {
  return scriptedRepoOperations({
    retireWorktree: async () => await new Promise<never>(() => undefined),
  });
}

function daemonAnsweringTheCall(): RepoOperations {
  return scriptedRepoOperations({
    retireWorktree: ({ worktreeId }) => Promise.resolve({ worktreeId, state: "retired" }),
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
    // Without this the case above would pass against a card that always said `Sending.`.
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
    // A card that cleared the record on any close would erase it before it could be read.
    const { container } = renderConfirmation(daemonAnsweringTheCall());

    await pressOpen();
    await pressConfirm();

    expect(container.querySelector(".meridian-root-removal__settled")).not.toBeNull();
  });
});
