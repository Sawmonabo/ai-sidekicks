// What the updates block's controls do: a found update downloads on a press, the restart is not
// offered before the download finishes and needs no confirmation, a call main does not answer is
// drawn in the block's own words, and the automatic-check switch, which a refused write leaves
// where it was. The doubles are in `UpdatesBlock.test-support.tsx`.
import { act } from "@testing-library/react";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { describe, expect, it, vi } from "vitest";
import {
  machineSettingsRefusing,
  machineSettingsUnreadable,
  preferencesAtDefaults,
  pressControl,
  renderOnMachineSettings,
  renderSettled,
  updaterReporting,
} from "./UpdatesBlock.test-support.js";

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
    expect(refusal?.textContent).toBe("Could not check for updates.");
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
      "Could not read the update status.",
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

describe("the updates block — a refused write puts the switch back", () => {
  it("keeps the value it had, says why with Try again, and sends the same change again", async () => {
    const machineSettings = machineSettingsRefusing(1, "The settings file is read-only.");
    const { block } = await renderOnMachineSettings(
      updaterReporting({ status: "idle" }),
      machineSettings,
    );
    const control = (): HTMLElement | null => block.querySelector('[role="switch"]');

    await act(async () => {
      control()?.click();
      await crossMacrotaskBoundary();
    });

    expect(machineSettings.writes).toStrictEqual([{ updatesAutomatic: false }]);
    expect(control()?.getAttribute("aria-checked")).toBe("true");
    const strip = block.querySelector("[data-refusal-code]");
    expect(strip?.querySelector(".meridian-refusal__message")?.textContent).toBe(
      "The settings file is read-only.",
    );
    // At its default the switch carries no changed mark.
    expect(block.querySelector('[aria-label="Changed from the default"]')).toBeNull();

    await pressControl(block, "Try again");

    expect(machineSettings.writes).toStrictEqual([
      { updatesAutomatic: false },
      { updatesAutomatic: false },
    ]);
    expect(control()?.getAttribute("aria-checked")).toBe("false");
    expect(block.querySelector("[data-refusal-code]")).toBeNull();
    expect(
      block.querySelector('[aria-label="Changed from the default"]')?.getAttribute("title"),
    ).toBe("On by default");
  });
});

describe("the updates block — the switch waits for the settings file", () => {
  it("draws no switch while the file cannot be read, says so with Try again, and reads again", async () => {
    const machineSettings = machineSettingsUnreadable(1);
    const { block } = await renderOnMachineSettings(
      updaterReporting({ status: "idle" }),
      machineSettings,
    );

    expect(block.querySelector('[role="switch"]')).toBeNull();
    expect(block.querySelector("[data-refusal-code] .meridian-refusal__message")?.textContent).toBe(
      "The settings could not be read.",
    );

    await pressControl(block, "Try again");

    expect(machineSettings.opens).toBe(2);
    expect(block.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    expect(block.querySelector("[data-refusal-code]")).toBeNull();
  });
});
