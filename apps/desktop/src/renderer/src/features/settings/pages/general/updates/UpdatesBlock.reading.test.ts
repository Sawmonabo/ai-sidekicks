// What the updates block reads, and what it says once it has read it.
//
// The arms the updater publishes, the ordering between the opening read and a
// transition pushed while it is still in flight, and the one polite announcement the
// settled read makes. What a control does with any of it is
// `UpdatesBlock.controls.test.ts`, over the doubles in `updates-block.test-support.tsx`.
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LIVE_ANNOUNCEMENT_HOLD_MS } from "@renderer/components/LiveAnnouncer/live-announcement-caps.js";
import { formatDate, formatDateTime } from "@renderer/lib/wire-figures.js";
import {
  renderSettled,
  updaterHoldingItsRead,
  updaterPushing,
  updaterReporting,
} from "./updates-block.test-support.js";

describe("the updates block — the updater's arms", () => {
  it("renders idle as nothing waiting", async () => {
    const { block: container } = await renderSettled(updaterReporting({ status: "idle" }));
    expect(container.textContent ?? "").toContain("No update is waiting");
  });

  it("renders idle's last check where the updater sent one", async () => {
    const { block: container } = await renderSettled(
      updaterReporting({ status: "idle", lastCheckedAt: "2026-01-01T09:30:00.000Z" }),
    );
    expect(container.textContent ?? "").toContain(formatDateTime("2026-01-01T09:30:00.000Z"));
  });

  it("renders idle's absent last check as the absence rather than as nothing", async () => {
    // A build nobody has checked on says so, instead of leaving the reader to guess
    // whether the check happened and was silent.
    const { block: container } = await renderSettled(updaterReporting({ status: "idle" }));
    expect(container.textContent ?? "").toContain("No check has finished in this installation.");
  });

  it("renders a found update with its version and its release", async () => {
    const { block } = await renderSettled(
      updaterReporting({
        status: "available",
        version: "1.4.0",
        releasedAt: "2026-09-28T16:00:00.000Z",
      }),
    );
    expect(block.textContent ?? "").toContain(
      `Update available — 1.4.0, released ${formatDate("2026-09-28T16:00:00.000Z")}.`,
    );
  });

  it("renders the signature check", async () => {
    const { block } = await renderSettled(updaterReporting({ status: "verifying" }));
    expect(block.textContent ?? "").toContain("Checking the signature…");
  });

  it("renders downloading with its own percent and a bar", async () => {
    const { block: container } = await renderSettled(
      updaterReporting({ status: "downloading", percent: 42 }),
    );
    const progress = container.querySelector("progress");
    expect(progress?.getAttribute("value")).toBe("42");
    expect(container.textContent ?? "").toContain("42%");
  });

  it("renders the error arm's message verbatim", async () => {
    const { block: container } = await renderSettled(
      updaterReporting({ status: "error", message: "the feed returned 503" }),
    );
    expect(container.textContent ?? "").toContain("the feed returned 503");
  });
});

describe("the updates block — the two sources are sequenced", () => {
  it("keeps a pushed transition when the opening read resolves behind it", async () => {
    // The block's own end of the race. Without the sequencing, the read's older
    // snapshot lands last and the ready arm — and its restart control — disappear
    // until the updater pushes again, which from a terminal arm it never does.
    const held = updaterHoldingItsRead();
    const { block } = await renderSettled(held.updater);

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
    const held = updaterHoldingItsRead();
    const { block } = await renderSettled(held.updater);
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
    const { politeText } = await renderSettled(updaterReporting({ status: "idle" }));
    expect(politeText()).toBe("Update state read. No update is waiting.");
  });

  it("negative control: a second push inside the same arm says nothing again", async () => {
    // Without this, a sentence carrying the download percent would satisfy the case
    // above and then announce once per percentage point — which fills the polite
    // queue with one condition and sheds every other announcement behind it.
    const pushing = updaterPushing({ status: "downloading", percent: 42 });
    const { block, clock, politeText } = await renderSettled(pushing.updater);
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
