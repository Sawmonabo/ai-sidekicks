// The five arms, the sixth state that is not an arm, and the control that only the
// ready arm offers.

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SidekicksBridge, UpdateState } from "@ai-sidekicks/contracts";

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

async function renderSettled(bridge: ConsoleBridge): Promise<HTMLElement> {
  let container: HTMLElement | undefined;
  await act(async () => {
    container = render(<UpdatesPage bridge={bridge} />).container;
    await Promise.resolve();
    await Promise.resolve();
  });
  return container as HTMLElement;
}

describe("updates page — the five arms", () => {
  it("renders idle as nothing waiting", async () => {
    const container = await renderSettled(bridgeReporting({ status: "idle" }));
    expect(container.textContent ?? "").toContain("No update is waiting");
  });

  it("renders downloading with its own percent and a bar", async () => {
    const container = await renderSettled(bridgeReporting({ status: "downloading", percent: 42 }));
    const progress = container.querySelector("progress");
    expect(progress?.getAttribute("value")).toBe("42");
    expect(container.textContent ?? "").toContain("42%");
  });

  it("renders the error arm's message verbatim", async () => {
    const container = await renderSettled(
      bridgeReporting({ status: "error", message: "the feed returned 503" }),
    );
    expect(container.textContent ?? "").toContain("the feed returned 503");
  });

  it("negative control: an unreachable feed is not the error arm", async () => {
    // The section is explicit — "A feed that cannot be reached is not an error arm
    // and does not render as one." Without this, an `unreachable` folded into
    // `error` would look identical to a real updater failure.
    const container = await renderSettled(bridgeWithNoUpdater());
    const text = container.textContent ?? "";
    expect(text).toContain("update feed was not reached");
    expect(text).not.toContain("The updater reported a failure");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });
});

describe("updates page — nothing restarts without a press", () => {
  it("offers the restart only once the download has finished", async () => {
    const ready = await renderSettled(bridgeReporting({ status: "ready" }));
    const labels = [...ready.querySelectorAll("button")].map((button) => button.textContent ?? "");
    expect(labels).toContain("Restart to apply");
  });

  it("negative control: a download in progress offers no restart", async () => {
    // Without this, the case above would pass over a page that always drew the
    // control — which would let a person restart into an incomplete download.
    const downloading = await renderSettled(
      bridgeReporting({ status: "downloading", percent: 99 }),
    );
    const labels = [...downloading.querySelectorAll("button")].map(
      (button) => button.textContent ?? "",
    );
    expect(labels).not.toContain("Restart to apply");
  });

  it("restarts only when the control is pressed", async () => {
    const requestRestart = vi.fn(() => Promise.resolve());
    const container = await renderSettled(bridgeReporting({ status: "ready" }, { requestRestart }));
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
    const container = await renderSettled(
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
