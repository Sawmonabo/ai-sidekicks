// The restart states its cost before it happens.
//
// The act this surface offers that cannot be taken back: `update.requestRestart()`
// quits the shell and relaunches it, ending every run on this node mid-turn. What is
// asserted here is that the press alone does nothing, that the answer is what acts,
// and — the part a screenshot could not check — that the sentence a person reads
// before answering names the work that stops AND says plainly that it cannot name all
// of it.

import { describe, expect, it, vi } from "vitest";

import {
  DAEMON_SHUTDOWN_FLUSH_BUDGET_MS,
  INTERRUPTED_RUN_IDS_NAMED_CAP,
} from "../../../../core/index.js";
import { formatDuration } from "../../../../primitives/index.js";
import {
  answerRestartConfirmation,
  bridgeReporting,
  openRestartConfirmation,
  renderSettled,
  restartDialog,
} from "./updates-block.test-support.js";
import { runEntity, sessionStoreHolding } from "../../../settings-page-mount.test-support.js";

describe("the restart confirmation — the press states, the answer acts", () => {
  it("does not restart on the press that opens the confirmation", async () => {
    const requestRestart = vi.fn(() => Promise.resolve());
    const { block } = await renderSettled(bridgeReporting({ status: "ready" }, { requestRestart }));
    await openRestartConfirmation(block);
    expect(restartDialog()).not.toBeNull();
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it("does not restart when the confirmation is declined", async () => {
    // The negative control the un-confirmed control never had: before this dialog the
    // press WAS the restart, so there was no state in which a person could change
    // their mind.
    const requestRestart = vi.fn(() => Promise.resolve());
    const { block } = await renderSettled(bridgeReporting({ status: "ready" }, { requestRestart }));
    await answerRestartConfirmation(block, "Not now");
    expect(requestRestart).not.toHaveBeenCalled();
  });
});

describe("the restart confirmation — what it says before it is answered", () => {
  it("names the flush budget the shell actually waits", async () => {
    const { block } = await renderSettled(bridgeReporting({ status: "ready" }));
    await openRestartConfirmation(block);
    // Read from the constant rather than written out, so a sentence promising ten
    // seconds over a shell that waits five is a red test rather than a lie on screen.
    expect(restartDialog()?.textContent ?? "").toContain(
      formatDuration(DAEMON_SHUTDOWN_FLUSH_BUDGET_MS),
    );
  });

  it("names the moving runs of the session this window has open", async () => {
    const sessionStore = sessionStoreHolding("session-restart", [
      runEntity("run-moving", "running"),
      runEntity("run-blocked", "waiting_for_approval"),
      runEntity("run-done", "completed"),
    ]);
    const { block } = await renderSettled(bridgeReporting({ status: "ready" }), sessionStore);
    await openRestartConfirmation(block);
    const said = restartDialog()?.textContent ?? "";
    expect(said).toContain("run-moving");
    expect(said).toContain("run-blocked");
    expect(said).not.toContain("run-done");
  });

  it("says so plainly when this window has no session to read", async () => {
    const { block } = await renderSettled(bridgeReporting({ status: "ready" }));
    await openRestartConfirmation(block);
    expect(restartDialog()?.textContent ?? "").toContain("no session open");
  });

  it("never claims the runs it can name are all of them", async () => {
    // Fail-closed honesty. A restart ends every run on the node and the renderer holds
    // only this window's sessions, so a count that stood alone would read as complete.
    const { block } = await renderSettled(
      bridgeReporting({ status: "ready" }),
      sessionStoreHolding("session-restart", [runEntity("run-moving", "running")]),
    );
    await openRestartConfirmation(block);
    expect(restartDialog()?.textContent ?? "").toContain(
      "Runs in sessions this window does not have open are interrupted too",
    );
  });

  it("caps the enumeration and still counts the rest", async () => {
    const runs = Array.from({ length: INTERRUPTED_RUN_IDS_NAMED_CAP + 2 }, (_unused, index) =>
      runEntity(`run-${index}`, "running"),
    );
    const { block } = await renderSettled(
      bridgeReporting({ status: "ready" }),
      sessionStoreHolding("session-restart", runs),
    );
    await openRestartConfirmation(block);
    const said = restartDialog()?.textContent ?? "";
    expect(said).toContain(`${INTERRUPTED_RUN_IDS_NAMED_CAP + 2} runs`);
    expect(said).toContain("2 others");
  });

  it("negative control: a session with nothing moving is said to have nothing moving", async () => {
    // Without this, a dialog that always named runs would satisfy the cases above
    // while telling a person work would stop that had already finished.
    const { block } = await renderSettled(
      bridgeReporting({ status: "ready" }),
      sessionStoreHolding("session-restart", [runEntity("run-done", "completed")]),
    );
    await openRestartConfirmation(block);
    expect(restartDialog()?.textContent ?? "").toContain("No run in the session");
  });
});
