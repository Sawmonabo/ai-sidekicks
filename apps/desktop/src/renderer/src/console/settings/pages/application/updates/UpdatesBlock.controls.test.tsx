// What the updates block's controls do, and what they refuse to do.
//
// The restart offered only by the finished arm, the single line every control failure
// lands on however it failed, the refusal that dies with the transport that raised it,
// and the automatic-update choice held for the window rather than for the section.
// What the block READS is `UpdatesBlock.reading.test.tsx`, over the one cast in
// `updates-block.test-support.tsx`.
import { crossMacrotaskBoundary } from "../../../../core/macrotask-boundary.test-support.js";
import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  answerRestartConfirmation,
  bridgeReporting,
  pressCheckNow,
  renderSettled,
} from "./updates-block.test-support.js";

describe("the updates block — nothing restarts without a press", () => {
  it("offers the restart only once the download has finished", async () => {
    const { block: ready } = await renderSettled(bridgeReporting({ status: "ready" }));
    const labels = [...ready.querySelectorAll("button")].map((button) => button.textContent ?? "");
    expect(labels).toContain("Restart to apply");
  });

  it("negative control: a download in progress offers no restart", async () => {
    // Without this, the case above would pass over a page that always drew the
    // control — which would let a person restart into an incomplete download.
    const { block: downloading } = await renderSettled(
      bridgeReporting({ status: "downloading", percent: 99 }),
    );
    const labels = [...downloading.querySelectorAll("button")].map(
      (button) => button.textContent ?? "",
    );
    expect(labels).not.toContain("Restart to apply");
  });

  it("restarts only when the confirmation is answered", async () => {
    const requestRestart = vi.fn(() => Promise.resolve());
    const { block: container } = await renderSettled(
      bridgeReporting({ status: "ready" }, { requestRestart }),
    );
    expect(requestRestart).not.toHaveBeenCalled();
    await answerRestartConfirmation(container, "Restart");
    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  it("renders a refused check beside the controls rather than swallowing it", async () => {
    const { block: container } = await renderSettled(
      bridgeReporting(
        { status: "idle" },
        { requestCheck: () => Promise.reject(new Error("the updater is disabled in this build")) },
      ),
    );
    await pressCheckNow(container);
    expect(container.textContent ?? "").toContain("the updater is disabled in this build");
  });

  it("puts the refuser's own code on screen beside its message", async () => {
    // The code used to be discarded entirely: `wireRejectionToError` puts a
    // registered daemon code on `Error.name` and this page read only `.message`, so
    // every refusal the updater namespace can raise reached a person with the one
    // part `Spec-023 §Console Design (Meridian)` rule 9 requires verbatim missing.
    const { block: container } = await renderSettled(
      bridgeReporting(
        { status: "idle" },
        {
          requestCheck: () =>
            Promise.reject({
              code: "update.channel_unavailable",
              message: "no feed is configured",
            }),
        },
      ),
    );
    await pressCheckNow(container);

    const refusal = container.querySelector(".meridian-refusal--inline");
    expect(refusal?.textContent ?? "").toContain("update.channel_unavailable");
    expect(refusal?.textContent ?? "").toContain("no feed is configured");
  });

  it("negative control: a code this page invented never displaces a registered one", async () => {
    // Without this, the case above would hold for a page that rendered its own
    // fallback code beside every message it happened to keep.
    const { block: container } = await renderSettled(
      bridgeReporting(
        { status: "idle" },
        {
          requestCheck: () =>
            Promise.reject({
              code: "update.channel_unavailable",
              message: "no feed is configured",
            }),
        },
      ),
    );
    await pressCheckNow(container);

    expect(container.textContent ?? "").not.toContain("control-failed");
  });
});

describe("the updates block — a control fails onto one line, however it failed", () => {
  it("renders the refusal when the control THROWS rather than rejecting", async () => {
    // The shape that matters on the build a person runs. The shipped Tier-1 bridge
    // implements every updater method as a synchronous `throw`, while the fixture's
    // refusals arrive as rejected promises — so a handler that attached its `catch`
    // to the RETURNED promise handled the fixture and let the release build's throw
    // escape the React event handler with no line ever drawn. This case fails on
    // that shape and is the negative control for it: the sentence below is never
    // set, because the call never reaches the boundary that sets it.
    const { block: container } = await renderSettled(
      bridgeReporting(
        { status: "idle" },
        {
          requestCheck: () => {
            throw new Error("the updater is not built into this build");
          },
        },
      ),
    );
    await pressCheckNow(container);
    expect(container.textContent ?? "").toContain("the updater is not built into this build");
  });

  it("renders the refusal when the restart control throws too", async () => {
    // The second control reaches the same namespace the same way, so it must reach
    // the same boundary — without this, a fix applied to one button would pass.
    const { block: container } = await renderSettled(
      bridgeReporting(
        { status: "ready" },
        {
          requestRestart: () => {
            throw new Error("the updater cannot restart this build");
          },
        },
      ),
    );
    await answerRestartConfirmation(container, "Restart");
    expect(container.textContent ?? "").toContain("the updater cannot restart this build");
  });

  it("negative control: a control that settles leaves no refusal line behind", async () => {
    // Without this, a page that rendered the aside unconditionally — or one that
    // reported a refusal on every press — would satisfy both cases above while
    // telling a person their successful check had failed.
    const { block: container } = await renderSettled(bridgeReporting({ status: "idle" }));
    await pressCheckNow(container);
    expect(container.querySelectorAll(".meridian-refusal")).toHaveLength(0);
  });
});

describe("the updates block — a choice held for the window outlives the section", () => {
  it("keeps the choice when the section is left and re-entered", async () => {
    // The negative control for a store built per calling component: under that shape
    // the store died with this block, so returning to the section showed the default
    // while the note still promised the choice was held for the window.
    const bridge = bridgeReporting({ status: "idle" });
    const first = await renderSettled(bridge);
    expect(first.toggle()?.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      first.toggle()?.click();
      await crossMacrotaskBoundary();
      await crossMacrotaskBoundary();
    });
    expect(first.toggle()?.getAttribute("aria-checked")).toBe("false");
    expect(first.block.textContent ?? "").toContain("Held in this window");
    first.unmount();

    const second = await renderSettled(bridge);

    expect(second.toggle()?.getAttribute("aria-checked")).toBe("false");
    expect(second.block.textContent ?? "").toContain("Held in this window");
  });

  it("negative control: a different bridge starts from the default again", async () => {
    // Without this, a holder that ignored the bridge entirely would satisfy the case
    // above and then answer a swapped scenario with the previous scenario's choice.
    const first = await renderSettled(bridgeReporting({ status: "idle" }));
    await act(async () => {
      first.toggle()?.click();
      await crossMacrotaskBoundary();
      await crossMacrotaskBoundary();
    });
    expect(first.toggle()?.getAttribute("aria-checked")).toBe("false");
    first.unmount();

    const second = await renderSettled(bridgeReporting({ status: "idle" }));

    expect(second.toggle()?.getAttribute("aria-checked")).toBe("true");
    expect(second.block.textContent ?? "").not.toContain("Held in this window");
  });
});

describe("the updates block — a refusal never outlives the transport that raised it", () => {
  it("drops the control refusal when the bridge is swapped under the mount", async () => {
    // The line was held in a plain `useState`, which survives a re-render carrying a
    // different transport — so a refusal one bridge raised stayed on screen beneath
    // controls that now reach a different updater, and the two sibling pages that had
    // already moved to the family's subject-scoped holder disagreed with this one.
    const view = await renderSettled(
      bridgeReporting(
        { status: "idle" },
        { requestCheck: () => Promise.reject(new Error("the updater is disabled in this build")) },
      ),
    );
    await pressCheckNow(view.block);
    expect(view.block.textContent ?? "").toContain("the updater is disabled in this build");

    await view.swapBridge(bridgeReporting({ status: "idle" }));

    expect(view.block.textContent ?? "").not.toContain("the updater is disabled in this build");
  });

  it("negative control: a re-render on the same bridge keeps the refusal standing", async () => {
    // Without this, a page that cleared the line on every render would satisfy the
    // case above by erasing a refusal the person had not yet read.
    const bridge = bridgeReporting(
      { status: "idle" },
      { requestCheck: () => Promise.reject(new Error("the updater is disabled in this build")) },
    );
    const view = await renderSettled(bridge);
    await pressCheckNow(view.block);
    expect(view.block.textContent ?? "").toContain("the updater is disabled in this build");

    await view.swapBridge(bridge);

    expect(view.block.textContent ?? "").toContain("the updater is disabled in this build");
  });
});
