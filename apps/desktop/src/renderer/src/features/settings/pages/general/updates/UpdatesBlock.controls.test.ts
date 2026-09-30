// What the updates block's controls do: the download offered only by a found update, the
// restart offered only by the finished arm, no confirmation between the press and the call,
// and the automatic-check switch.
// What the block READS is `UpdatesBlock.reading.test.ts`, over the doubles in
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

  it("negative control: an update already downloading offers no download", async () => {
    const { block } = await renderSettled(updaterReporting({ status: "downloading", percent: 10 }));
    const labels = [...block.querySelectorAll("button")].map((button) => button.textContent ?? "");
    expect(labels).not.toContain("Download");
  });
});

describe("the updates block — nothing restarts without a press", () => {
  it("offers the restart only once the download has finished", async () => {
    const { block: ready } = await renderSettled(updaterReporting({ status: "ready" }));
    const labels = [...ready.querySelectorAll("button")].map((button) => button.textContent ?? "");
    expect(labels).toContain("Restart to apply");
  });

  it("negative control: a download in progress offers no restart", async () => {
    // Without this, the case above would pass over a page that always drew the
    // control — which would let a person restart into an incomplete download.
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
    const control = block.querySelector<HTMLElement>(".meridian-settings-row__switch");
    expect(control?.getAttribute("aria-checked")).toBe("true");

    act(() => {
      control?.click();
    });

    expect(choose).toHaveBeenCalledWith("updatesAutomatic", false);
  });
});
