// What the updates block's controls do: the restart offered only by the finished arm,
// no confirmation between the press and the call, and the automatic-check switch.
// What the block READS is `UpdatesBlock.reading.test.ts`, over the doubles in
// `updates-block.test-support.tsx`.
import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  preferencesAtDefaults,
  pressRestart,
  renderSettled,
  updaterReporting,
} from "./updates-block.test-support.js";

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
    await pressRestart(container);
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

    expect(choose).toHaveBeenCalledWith("updates.automatic", false);
  });
});
