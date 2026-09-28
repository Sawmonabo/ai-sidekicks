// What the updates block's controls do: the restart offered only by the finished arm,
// and no confirmation between the press and the call.
// What the block READS is `UpdatesBlock.reading.test.tsx`, over the doubles in
// `updates-block.test-support.tsx`.
import { describe, expect, it, vi } from "vitest";
import { pressRestart, renderSettled, updaterReporting } from "./updates-block.test-support.js";

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
