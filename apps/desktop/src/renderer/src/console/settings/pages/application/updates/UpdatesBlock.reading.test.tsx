// What the updates block reads, and what it says once it has read it.
//
// The five arms the updater publishes, the ordering between the opening read and a
// transition pushed while it is still in flight, and the one polite announcement the
// settled read makes. What a control does with any of it is
// `UpdatesBlock.controls.test.tsx`, over the one cast in `updates-block.test-support.tsx`.
import { crossMacrotaskBoundary } from "../../../../core/macrotask-boundary.test-support.js";
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LIVE_ANNOUNCEMENT_HOLD_MS } from "../../../../core/index.js";
import {
  bridgeHoldingItsRead,
  bridgePushing,
  bridgeReporting,
  bridgeWithNoUpdater,
  renderSettled,
} from "./updates-block.test-support.js";

describe("the updates block — the five arms", () => {
  it("renders idle as nothing waiting", async () => {
    const { block: container } = await renderSettled(bridgeReporting({ status: "idle" }));
    expect(container.textContent ?? "").toContain("No update is waiting");
  });

  it("renders downloading with its own percent and a bar", async () => {
    const { block: container } = await renderSettled(
      bridgeReporting({ status: "downloading", percent: 42 }),
    );
    const progress = container.querySelector("progress");
    expect(progress?.getAttribute("value")).toBe("42");
    expect(container.textContent ?? "").toContain("42%");
  });

  it("renders the error arm's message verbatim", async () => {
    const { block: container } = await renderSettled(
      bridgeReporting({ status: "error", message: "the feed returned 503" }),
    );
    expect(container.textContent ?? "").toContain("the feed returned 503");
  });

  it("negative control: an unreachable feed is not the error arm", async () => {
    // The section is explicit — "A feed that cannot be reached is not an error arm
    // and does not render as one." Without this, an `unreachable` folded into
    // `error` would look identical to a real updater failure.
    const { block: container } = await renderSettled(bridgeWithNoUpdater());
    const text = container.textContent ?? "";
    expect(text).toContain("update feed was not reached");
    expect(text).not.toContain("The updater reported a failure");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it("names the leg that could not be reached, in a code a person can quote", async () => {
    // The arm used to render the thrown message alone. `wireRejectionToError` puts a
    // code on `Error.name` and this seam read only `.message`, so nothing on screen
    // said WHICH conversation failed — and a registered daemon code would have been
    // discarded the same way. The sentence stays an aside and the code arrives with
    // it, in the console's own inline shape rather than as a second kind of prose.
    const { block: container } = await renderSettled(bridgeWithNoUpdater());

    const refusal = container.querySelector(".meridian-refusal--inline");
    expect(refusal?.textContent ?? "").toContain("updater-subscribe-failed");
    expect(
      container.querySelector(".meridian-settings-page__aside .meridian-refusal"),
    ).not.toBeNull();
  });
});

describe("the updates block — the two sources are sequenced", () => {
  it("keeps a pushed transition when the opening read resolves behind it", async () => {
    // The block's own end of the race. Without the sequencing, the read's older
    // snapshot lands last and the ready arm — and its restart control — disappear
    // until the updater pushes again, which from a terminal arm it never does.
    const held = bridgeHoldingItsRead();
    const { block } = await renderSettled(held.bridge);

    await act(async () => {
      held.push({ status: "ready" });
      held.settleRead({ status: "checking" });
      await crossMacrotaskBoundary();
      await crossMacrotaskBoundary();
    });

    const text = block.textContent ?? "";
    expect(text).toContain("An update has finished downloading");
    expect(text).not.toContain("Checking for an update");
    const labels = [...block.querySelectorAll("button")].map((button) => button.textContent ?? "");
    expect(labels).toContain("Restart to apply");
  });

  it("negative control: the opening read still installs when nothing was pushed", async () => {
    // Without this, a block that ignored its opening read outright would satisfy the
    // case above and then show "Reading the updater's state" for the window's life.
    const held = bridgeHoldingItsRead();
    const { block } = await renderSettled(held.bridge);
    expect(block.textContent ?? "").toContain("Reading the updater");

    await act(async () => {
      held.settleRead({ status: "idle" });
      await crossMacrotaskBoundary();
      await crossMacrotaskBoundary();
    });

    expect(block.textContent ?? "").toContain("No update is waiting");
  });
});

describe("the updates block — the read says it landed, once", () => {
  it("announces what the updater answered", async () => {
    const { politeText } = await renderSettled(bridgeReporting({ status: "idle" }));
    expect(politeText()).toBe("Update state read. No update is waiting.");
  });

  it("announces an unreachable feed in the words the failure arrived in", async () => {
    const { politeText } = await renderSettled(bridgeWithNoUpdater());
    const spoken = politeText();
    expect(spoken).toContain("The update feed was not reached from this window.");
    // The SUBSCRIBE rejection, not the read's: the block opens the subscription
    // first, so that is the message the unreachable arm actually settles on.
    expect(spoken).toContain("update.subscribe is not implemented");
  });

  it("negative control: a second push inside the same arm says nothing again", async () => {
    // Without this, a sentence carrying the download percent would satisfy the case
    // above and then announce once per percentage point — which fills the polite
    // queue with one condition and sheds every other announcement behind it.
    const pushing = bridgePushing({ status: "downloading", percent: 42 });
    const { block, clock, politeText } = await renderSettled(pushing.bridge);
    expect(politeText()).toBe("Update state read. An update is downloading.");

    await act(async () => {
      clock.advance(LIVE_ANNOUNCEMENT_HOLD_MS);
      await crossMacrotaskBoundary();
    });
    expect(politeText()).toBe("");

    await act(async () => {
      pushing.push({ status: "downloading", percent: 43 });
      await crossMacrotaskBoundary();
    });

    // The block really did re-render on the push, so the silence is the hook's doing
    // rather than a component that stopped listening.
    expect(block.textContent ?? "").toContain("43%");
    expect(politeText()).toBe("");
  });
});
