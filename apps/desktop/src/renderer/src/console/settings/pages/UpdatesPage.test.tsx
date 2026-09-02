// The five arms, the sixth state that is not an arm, and the control that only the
// ready arm offers.

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SidekicksBridge, UpdateState, Unsubscribe } from "@ai-sidekicks/contracts";

import { LIVE_ANNOUNCEMENT_HOLD_MS, ManualClock } from "../../core/index.js";
import { LiveAnnouncer, LiveAnnouncerProvider } from "../../primitives/index.js";
import {
  fixtureBridgeWithGrowth,
  growthRefusing,
  unscriptedScenario,
} from "../../bridge/fixture-bridge-overrides.test-support.js";
import { UpdatesPage } from "./UpdatesPage.js";
import type { ConsoleBridge, GrowthPort } from "../../bridge/index.js";

const SCENARIO = unscriptedScenario("updates-page-test");

/**
 * The preference carrier nobody has registered.
 *
 * The block's automatic-update toggle rides it, so every case here needs it to
 * answer; the refusal is the shipped port's own, not a literal written out beside a
 * value nothing checks it against.
 */
const REFUSING_CARRIER: Partial<GrowthPort> = {
  shellConfigRead: growthRefusing("shellConfigRead"),
  shellConfigWrite: growthRefusing("shellConfigWrite"),
};

/**
 * The shipped fixture bridge with its updater namespace replaced.
 *
 * The updater is the one seam these cases drive, and it is NOT a growth operation —
 * it is a registered `SidekicksBridge` namespace, so it is replaced here rather than
 * through the growth overrides. Everything else is the fixture's, which is what makes
 * the type annotation load-bearing: an arm added to `UpdateState` upstream fails this
 * file to compile instead of leaving a case asserting against a shape nobody serves.
 */
function bridgeWithUpdater(update: SidekicksBridge["update"]): ConsoleBridge {
  const fixture = fixtureBridgeWithGrowth(SCENARIO, REFUSING_CARRIER);
  return { ...fixture, sidekicks: { ...fixture.sidekicks, update } };
}

function bridgeReporting(
  state: UpdateState,
  controls: { requestCheck?: () => Promise<void>; requestRestart?: () => Promise<void> } = {},
): ConsoleBridge {
  return bridgeWithUpdater({
    getState: () => Promise.resolve(state),
    subscribe: () => () => undefined,
    requestCheck: controls.requestCheck ?? (() => Promise.resolve()),
    requestRestart: controls.requestRestart ?? (() => Promise.resolve()),
  });
}

/** A bridge whose updater cannot be reached at all — the shipped Tier-1 posture. */
function bridgeWithNoUpdater(): ConsoleBridge {
  return bridgeWithUpdater({
    getState: () => Promise.reject(new Error("update.getState is not implemented")),
    subscribe: () => {
      throw new Error("update.subscribe is not implemented");
    },
    requestCheck: () => Promise.resolve(),
    requestRestart: () => Promise.resolve(),
  });
}

/**
 * A bridge whose updater pushes on demand, so a case can drive a second transition.
 *
 * The handler is captured rather than replayed from a script, because what these
 * cases need is a push that lands AFTER the first read settled — which is exactly the
 * moment a page that announced on every state change would speak a second time.
 */
function bridgePushing(initial: UpdateState): {
  readonly bridge: ConsoleBridge;
  readonly push: (state: UpdateState) => void;
} {
  let deliver: ((state: UpdateState) => void) | undefined;
  const bridge = bridgeWithUpdater({
    getState: () => Promise.resolve(initial),
    subscribe: (handler): Unsubscribe => {
      deliver = handler;
      return () => undefined;
    },
    requestCheck: () => Promise.resolve(),
    requestRestart: () => Promise.resolve(),
  });
  return {
    bridge,
    push: (state) => {
      deliver?.(state);
    },
  };
}

/**
 * A bridge whose opening read is settled by hand, so a push can land ahead of it.
 *
 * Separate from {@link bridgePushing} rather than an option on it: that builder's
 * read resolves immediately, which is what its own cases need, and the case here
 * needs the opposite — a read still in flight when the updater pushes, which is the
 * moment an unconditional continuation overwrites the newer state with the older.
 */
function bridgeHoldingItsRead(): {
  readonly bridge: ConsoleBridge;
  readonly push: (state: UpdateState) => void;
  readonly settleRead: (state: UpdateState) => void;
} {
  let deliver: ((state: UpdateState) => void) | undefined;
  let settle: ((state: UpdateState) => void) | undefined;
  const bridge = bridgeWithUpdater({
    getState: () =>
      new Promise<UpdateState>((resolve) => {
        settle = resolve;
      }),
    subscribe: (handler): Unsubscribe => {
      deliver = handler;
      return () => undefined;
    },
    requestCheck: () => Promise.resolve(),
    requestRestart: () => Promise.resolve(),
  });
  return {
    bridge,
    push: (state) => {
      deliver?.(state);
    },
    settleRead: (state) => {
      settle?.(state);
    },
  };
}

/** The block's own element, so a case never reads the announcer's regions by accident. */
function updatesBlockOf(root: HTMLElement): HTMLElement {
  const block = root.querySelector<HTMLElement>('section[aria-label="Application updates"]');
  if (block === null) {
    throw new Error("the updates block did not render");
  }
  return block;
}

/**
 * Mount the block under the console's real announcer and let its read settle.
 *
 * The announcer runs on a `ManualClock` so its hold window is frozen: whether a
 * sentence was said a second time is otherwise a question about how fast the runner
 * happened to be. The BLOCK is returned rather than the render container, because the
 * two live regions are the provider's siblings above it and one of them carries
 * `role="alert"` — a case asserting this block raises no alert would otherwise be
 * reading the announcer's.
 */
async function renderSettled(bridge: ConsoleBridge): Promise<{
  readonly page: HTMLElement;
  readonly clock: ManualClock;
  readonly politeText: () => string;
}> {
  const clock = new ManualClock();
  const announcer = new LiveAnnouncer({ clock });
  let root: HTMLElement | undefined;
  await act(async () => {
    root = render(
      <LiveAnnouncerProvider announcer={announcer}>
        <UpdatesPage bridge={bridge} />
      </LiveAnnouncerProvider>,
    ).container;
    await Promise.resolve();
    await Promise.resolve();
  });
  const mounted = root as HTMLElement;
  return {
    page: updatesBlockOf(mounted),
    clock,
    politeText: () => mounted.querySelector('[data-live-region="polite"]')?.textContent ?? "",
  };
}

describe("updates page — the five arms", () => {
  it("renders idle as nothing waiting", async () => {
    const { page: container } = await renderSettled(bridgeReporting({ status: "idle" }));
    expect(container.textContent ?? "").toContain("No update is waiting");
  });

  it("renders downloading with its own percent and a bar", async () => {
    const { page: container } = await renderSettled(
      bridgeReporting({ status: "downloading", percent: 42 }),
    );
    const progress = container.querySelector("progress");
    expect(progress?.getAttribute("value")).toBe("42");
    expect(container.textContent ?? "").toContain("42%");
  });

  it("renders the error arm's message verbatim", async () => {
    const { page: container } = await renderSettled(
      bridgeReporting({ status: "error", message: "the feed returned 503" }),
    );
    expect(container.textContent ?? "").toContain("the feed returned 503");
  });

  it("negative control: an unreachable feed is not the error arm", async () => {
    // The section is explicit — "A feed that cannot be reached is not an error arm
    // and does not render as one." Without this, an `unreachable` folded into
    // `error` would look identical to a real updater failure.
    const { page: container } = await renderSettled(bridgeWithNoUpdater());
    const text = container.textContent ?? "";
    expect(text).toContain("update feed was not reached");
    expect(text).not.toContain("The updater reported a failure");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });
});

describe("updates page — the two sources are sequenced", () => {
  it("keeps a pushed transition when the opening read resolves behind it", async () => {
    // The block's own end of the race. Without the sequencing, the read's older
    // snapshot lands last and the ready arm — and its restart control — disappear
    // until the updater pushes again, which from a terminal arm it never does.
    const held = bridgeHoldingItsRead();
    const { page } = await renderSettled(held.bridge);

    await act(async () => {
      held.push({ status: "ready" });
      held.settleRead({ status: "checking" });
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = page.textContent ?? "";
    expect(text).toContain("An update has finished downloading");
    expect(text).not.toContain("Checking for an update");
    const labels = [...page.querySelectorAll("button")].map((button) => button.textContent ?? "");
    expect(labels).toContain("Restart to apply");
  });

  it("negative control: the opening read still installs when nothing was pushed", async () => {
    // Without this, a block that ignored its opening read outright would satisfy the
    // case above and then show "Reading the updater's state" for the window's life.
    const held = bridgeHoldingItsRead();
    const { page } = await renderSettled(held.bridge);
    expect(page.textContent ?? "").toContain("Reading the updater");

    await act(async () => {
      held.settleRead({ status: "idle" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(page.textContent ?? "").toContain("No update is waiting");
  });
});

describe("updates page — nothing restarts without a press", () => {
  it("offers the restart only once the download has finished", async () => {
    const { page: ready } = await renderSettled(bridgeReporting({ status: "ready" }));
    const labels = [...ready.querySelectorAll("button")].map((button) => button.textContent ?? "");
    expect(labels).toContain("Restart to apply");
  });

  it("negative control: a download in progress offers no restart", async () => {
    // Without this, the case above would pass over a page that always drew the
    // control — which would let a person restart into an incomplete download.
    const { page: downloading } = await renderSettled(
      bridgeReporting({ status: "downloading", percent: 99 }),
    );
    const labels = [...downloading.querySelectorAll("button")].map(
      (button) => button.textContent ?? "",
    );
    expect(labels).not.toContain("Restart to apply");
  });

  it("restarts only when the control is pressed", async () => {
    const requestRestart = vi.fn(() => Promise.resolve());
    const { page: container } = await renderSettled(
      bridgeReporting({ status: "ready" }, { requestRestart }),
    );
    expect(requestRestart).not.toHaveBeenCalled();
    const restart = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Restart to apply",
    );
    await act(async () => {
      restart?.click();
      await Promise.resolve();
    });
    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  it("renders a refused check beside the controls rather than swallowing it", async () => {
    const { page: container } = await renderSettled(
      bridgeReporting(
        { status: "idle" },
        { requestCheck: () => Promise.reject(new Error("the updater is disabled in this build")) },
      ),
    );
    const check = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Check now",
    );
    await act(async () => {
      check?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent ?? "").toContain("the updater is disabled in this build");
  });
});

describe("updates page — the read says it landed, once", () => {
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
    const { page, clock, politeText } = await renderSettled(pushing.bridge);
    expect(politeText()).toBe("Update state read. An update is downloading.");

    await act(async () => {
      clock.advance(LIVE_ANNOUNCEMENT_HOLD_MS);
      await Promise.resolve();
    });
    expect(politeText()).toBe("");

    await act(async () => {
      pushing.push({ status: "downloading", percent: 43 });
      await Promise.resolve();
    });

    // The block really did re-render on the push, so the silence is the hook's doing
    // rather than a component that stopped listening.
    expect(page.textContent ?? "").toContain("43%");
    expect(politeText()).toBe("");
  });
});
