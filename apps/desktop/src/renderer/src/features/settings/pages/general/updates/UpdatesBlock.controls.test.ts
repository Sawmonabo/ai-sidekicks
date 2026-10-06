// What the updates block's controls do: a found update downloads on a press, the restart is not
// offered before the download finishes and needs no confirmation, a call main does not answer is
// drawn in the block's own words, and the automatic-check switch. The doubles are in
// `updates-block.test-support.tsx`.
import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  preferencesAtDefaults,
  pressControl,
  renderSettled,
  updaterReporting,
} from "./updates-block.test-support.js";

describe("the updates block — nothing downloads without a press", () => {
  it("offers the download on a found update, and downloads on a press", async () => {
    const requestDownload = vi.fn(() => Promise.resolve());
    const { block } = await renderSettled(
      updaterReporting(
        { status: "available", version: "1.4.0", releasedAt: "2026-09-28T16:00:00.000Z" },
        { requestDownload },
      ),
    );
    expect(requestDownload).not.toHaveBeenCalled();
    await pressControl(block, "Download");
    expect(requestDownload).toHaveBeenCalledTimes(1);
  });
});

describe("the updates block — nothing restarts without a press", () => {
  it("negative control: a download in progress offers no restart", async () => {
    // Guards against a page that always draws the control, letting a person restart into an
    // incomplete download.
    const { block: downloading } = await renderSettled(
      updaterReporting({ status: "downloading", percent: 99 }),
    );
    const labels = [...downloading.querySelectorAll("button")].map(
      (button) => button.textContent ?? "",
    );
    expect(labels).not.toContain("Restart to apply");
  });

  it("restarts on a press, with no confirmation in between", async () => {
    const requestRestart = vi.fn(() => Promise.resolve());
    const { block: container } = await renderSettled(
      updaterReporting({ status: "ready" }, { requestRestart }),
    );
    expect(requestRestart).not.toHaveBeenCalled();
    await pressControl(container, "Restart to apply");
    expect(requestRestart).toHaveBeenCalledTimes(1);
  });
});

/** What Electron rejects a call with when main has no handler on its channel. */
function noHandlerFor(channel: string): Error {
  return new Error(
    `Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`,
  );
}

describe("the updates block — a call main does not answer is drawn in the block's words", () => {
  it("draws a refused check under the controls, never the message that crossed IPC", async () => {
    const requestCheck = vi.fn(() => Promise.reject(noHandlerFor("update.requestCheck")));
    const { block } = await renderSettled(updaterReporting({ status: "idle" }, { requestCheck }));
    expect(block.querySelector("[data-refusal-code]")).toBeNull();

    await pressControl(block, "Check now");

    expect(requestCheck).toHaveBeenCalledTimes(1);
    const refusal = block.querySelector("[data-refusal-code]");
    expect(refusal?.getAttribute("data-refusal-code")).toBe("updater-control-failed");
    expect(refusal?.textContent).toBe(
      "The update check could not start. The updater runs in the main process, and this " +
        "window could not reach it.",
    );
    expect(block.textContent).not.toContain("update.requestCheck");
    const labels = [...block.querySelectorAll("button")].map((button) => button.textContent);
    expect(labels).toContain("Check now");
  });

  it("draws a refused read in place of the state, never the message that crossed IPC", async () => {
    const { block } = await renderSettled({
      ...updaterReporting({ status: "idle" }),
      getState: () => Promise.reject(noHandlerFor("update.getState")),
    });

    expect(block.querySelector("[data-refusal-code]")?.textContent).toBe(
      "The update state could not be read. The updater runs in the main process, and this " +
        "window could not reach it.",
    );
    expect(block.textContent).not.toContain("update.getState");
  });
});

describe("the updates block — checking on its own", () => {
  it("draws the switch on by default, and a press turns it off", async () => {
    const choose = vi.fn();
    const { block } = await renderSettled(
      updaterReporting({ status: "idle" }),
      preferencesAtDefaults(choose),
    );
    expect(block.querySelector(".meridian-settings-row__label")?.textContent).toBe(
      "Check for updates automatically",
    );
    const control = block.querySelector<HTMLElement>('[role="switch"]');
    expect(control?.getAttribute("aria-checked")).toBe("true");

    act(() => {
      control?.click();
    });

    expect(choose).toHaveBeenCalledWith("updatesAutomatic", false);
  });
});
