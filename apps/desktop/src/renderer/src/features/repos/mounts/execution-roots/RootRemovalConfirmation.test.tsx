// A settlement belongs to the press that produced it, and closing does not take it back. The
// confirm is an `AlertDialog.Close`, so it sends and closes in one act; a discard wired to every
// close would fire right after `send()` published `sending`, idling the card and re-enabling the
// trigger under a call still on the wire. The popup is portaled, so presses are read off
// `document`.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
import { scriptedRepoOperations } from "../../repo-operations.test-support.js";
import type { RepoOperations } from "../../repo-operations.js";
import { confirmationPresses } from "../repo-mounts.test-support.js";
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
    />,
  );
}

const { trigger, pressOpen, pressConfirm, pressCancel } =
  confirmationPresses("meridian-root-removal");

describe("RootRemovalConfirmation — the confirm press keeps its settlement", () => {
  it(
    "still reports the removal as sent once the confirm control has " + "closed the dialog",
    async () => {
      const { container } = renderConfirmation(daemonHoldingTheCall());

      await pressOpen();
      await pressConfirm();

      expect(container.textContent).toContain("Sending.");
      expect(trigger()?.disabled).toBe(true);
    },
  );
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
});
