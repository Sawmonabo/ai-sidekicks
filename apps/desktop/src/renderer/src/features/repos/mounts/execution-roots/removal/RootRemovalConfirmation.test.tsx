// A settlement belongs to the press that produced it, and closing does not take it back. The
// confirm is an `AlertDialog.Close`, so it sends and closes in one act; a discard wired to every
// close would fire right after `send()` published `sending`, idling the card and re-enabling the
// trigger under a call still on the wire. The popup is portaled, so presses are read off
// `document`.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { bridgeOnClock } from "#test/helpers/fixture/bridge.js";
import { scriptedRepoOperations } from "#renderer/features/repos/operations.test-support.js";
import type { RepoOperations } from "#renderer/features/repos/operations.js";
import { confirmationPresses } from "../../repo-mounts.test-support.js";
import { RootRemovalConfirmation } from "./RootRemovalConfirmation.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { LIVE_ANNOUNCEMENT_HOLD_MS } from "#renderer/components/LiveAnnouncer/caps.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { drawnText, liveRegionText } from "#test/helpers/live-region.js";

/** The line a settled removal draws. */
const SETTLEMENT_LINE = ".meridian-form__settlement";

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

/** The confirmation under an announcer on `clock`, so a case can let "Sending." stand down. */
function renderConfirmation(
  operations: RepoOperations,
  clock = new ManualClock(0),
): ReturnType<typeof render> {
  return render(
    <LiveAnnouncerProvider clock={clock}>
      <RootRemovalConfirmation
        bridge={bridgeOnClock("repos").bridge}
        operations={operations}
        rootId={WORKTREE_ID}
      />
    </LiveAnnouncerProvider>,
  );
}

const { trigger, pressOpen, pressConfirm, pressCancel } = confirmationPresses({
  trigger: `Remove ${WORKTREE_ID}`,
  confirm: "Remove",
  cancel: "Keep it",
});

describe("RootRemovalConfirmation — the confirm press keeps its settlement", () => {
  it("still reports the removal as sent once confirming has closed the dialog", async () => {
    const { container } = renderConfirmation(daemonHoldingTheCall());

    await pressOpen();
    await pressConfirm();

    expect(drawnText(container)).toContain("Sending.");
    expect(trigger()?.disabled).toBe(true);
  });
});

describe("RootRemovalConfirmation — a discarded consideration", () => {
  it("discards the standing settlement when the user walks away from the question", async () => {
    const clock = new ManualClock(0);
    const { container } = renderConfirmation(daemonAnsweringTheCall(), clock);

    await pressOpen();
    await pressConfirm();
    act(() => {
      clock.advance(LIVE_ANNOUNCEMENT_HOLD_MS);
    });
    const settlement = container.querySelector(SETTLEMENT_LINE)?.textContent;
    expect(settlement).toBeTruthy();
    expect(liveRegionText(container, "polite")).toBe(settlement);

    await pressOpen();
    await pressCancel();

    expect(container.querySelector(SETTLEMENT_LINE)).toBeNull();
  });
});
