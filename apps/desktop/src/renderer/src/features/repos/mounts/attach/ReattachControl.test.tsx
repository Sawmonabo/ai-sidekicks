// The re-attach a person pressed goes on being reported after the dialog shuts.
//
// THE SAME DEFECT AS `execution-roots/RootRemovalConfirmation.test.tsx` PINS, on the family's
// other alert dialog. The confirm control is an `AlertDialog.Close`, so it sends and
// closes in one act; a discard wired to every close fires straight after `attach()`
// published `sending`, and the card falls back to idle with its trigger live again
// under an attach still on the wire. The second press then reaches the act
// controller's single-flight guard and returns silently.
//
// THE POPUP IS PORTALLED, so the acts are read off `document` and the settlement off
// the render container, which is where this control draws it: on the card, beside the
// verdict it is about.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RepoAttachResponse } from "@ai-sidekicks/contracts";

import type { RepoOperations } from "../../repo-operations.js";
import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
import { scriptedRepoOperations } from "../../repo-operations.test-support.js";
import { ReattachControl } from "./ReattachControl.js";

const SESSION_ID = "019b79ee-0280-740e-8110-d1a4c1150091";

const LOCAL_PATH = "/Users/dev/code/ai-sidekicks/packages/contracts";

/** An attach that never answers, so the sent state stays observable. */
function operationsHoldingTheCall(): RepoOperations {
  return scriptedRepoOperations({
    attachRepository: async () => await new Promise<never>(() => undefined),
  });
}

/** An attach that mints a mount, so a settlement lands on the card. */
function operationsAnsweringTheCall(): RepoOperations {
  return scriptedRepoOperations({
    attachRepository: () =>
      Promise.resolve({
        repoMountId: "mount-new",
        state: "attached",
        vcsType: "git",
        canonicalRoot: LOCAL_PATH,
      } as unknown as RepoAttachResponse),
  });
}

function renderControl(operations: RepoOperations): ReturnType<typeof render> {
  return render(
    <ReattachControl
      bridge={bridgeOnClock("repos").bridge}
      operations={operations}
      sessionId={SESSION_ID}
      localPath={LOCAL_PATH}
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
    const { container } = renderControl(operationsHoldingTheCall());

    await pressOpen();
    await pressConfirm();

    expect(container.textContent).toContain("Re-attaching.");
    expect(trigger()?.disabled).toBe(true);
  });

  it("negative control: with nothing pressed the card carries no settlement and the trigger is live", async () => {
    // Without this the case above would pass against a card that always said
    // `Re-attaching.` and always held its trigger, which is a remedy nobody can reach.
    const { container } = renderControl(operationsHoldingTheCall());

    await pressOpen();

    expect(container.textContent).not.toContain("Re-attaching.");
    expect(trigger()?.disabled).toBe(false);
  });
});

describe("ReattachControl — a discarded consideration", () => {
  it("discards the standing settlement when the user walks away from the question", async () => {
    const { container } = renderControl(operationsAnsweringTheCall());

    await pressOpen();
    await pressConfirm();
    expect(container.querySelector(".meridian-reattach__attached")).not.toBeNull();

    await pressOpen();
    await pressCancel();

    expect(container.querySelector(".meridian-reattach__attached")).toBeNull();
  });

  it("negative control: a settlement nobody reconsidered stays on the card", async () => {
    // The settlement is the only place the outcome is written. Cleared on any close, it
    // would be gone before the person who pressed could read it.
    const { container } = renderControl(operationsAnsweringTheCall());

    await pressOpen();
    await pressConfirm();

    expect(container.querySelector(".meridian-reattach__attached")).not.toBeNull();
  });
});
