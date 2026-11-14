// The General page draws the update block from the window's reading of the updater: the step a
// served state is on, and a refused read that reads again through the page's `Try again`.
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { PlatformBridgeProvider } from "#renderer/services/platform/PlatformBridgeProvider.js";
import { useUpdateReading } from "#renderer/store/update/hooks/useUpdateReading.js";
import type { UpdaterCalls } from "#renderer/store/update/reading.js";
import { unscriptedScenario } from "#test/helpers/fixture/bridge.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { settingsPageContextWith } from "#test/helpers/settings-page-mount.js";
import { GeneralPage } from "./GeneralPage.js";
import {
  machineSettingsUnreadable,
  noHandlerFor,
  pressControl,
  updaterReporting,
} from "./updates/UpdatesBlock.test-support.js";

describe("the General page — the update block", () => {
  it("draws the step a served download is on, the steps behind it ticked", async () => {
    const { block } = await renderGeneralPage(
      updaterReporting({ status: "downloading", percent: 40 }),
    );

    expect(block.querySelector("label")?.textContent).toBe("Downloading… 40%");
    const steps = [...block.querySelectorAll("ol li")].map((step) => [
      step.textContent,
      step.getAttribute("data-progress"),
    ]);
    expect(steps).toStrictEqual([
      ["Checked", "done"],
      ["Downloading", "now"],
      ["Checking the signature…", "todo"],
      ["Ready to install", "todo"],
      ["Restart to finish", "todo"],
    ]);
    expect(block.querySelector('[aria-current="step"]')?.textContent).toBe("Downloading");
  });

  it("draws a refused read in place of the state, and reads again on Try again", async () => {
    const getState = vi
      .fn<UpdaterCalls["getState"]>()
      .mockRejectedValueOnce(noHandlerFor("update.getState"))
      .mockResolvedValue({ status: "idle" });
    const { block, runningVersion } = await renderGeneralPage({
      ...updaterReporting({ status: "idle" }),
      getState,
    });

    expect(block.querySelector(".meridian-refusal__message")?.textContent).toBe(
      "Couldn't load update status",
    );
    expect(block.textContent).not.toContain("update.getState");

    await pressControl(block, "Try again");

    expect(getState).toHaveBeenCalledTimes(2);
    expect(block.querySelector("[data-refusal-code]")).toBeNull();
    expect(block.querySelector(".meridian-settings-page__state")?.textContent).toBe(
      `The newest version seen is ${runningVersion}.`,
    );
  });
});

/** The page as a window draws it: the window binds the reading over `updater` and hands it in. */
function GeneralPageOnUpdater(props: {
  readonly bridge: PlatformBridge;
  readonly updater: UpdaterCalls;
}): React.JSX.Element {
  const updateReading = useUpdateReading(props.updater, useClock());
  return (
    <GeneralPage context={settingsPageContextWith(props.bridge, undefined, { updateReading })} />
  );
}

/** Mount the page over `updater`, let its reads settle, and return its update block. */
async function renderGeneralPage(
  updater: UpdaterCalls,
): Promise<{ readonly block: HTMLElement; readonly runningVersion: string }> {
  const fixture = createFixtureBridge({ scenario: unscriptedScenario("general-page") }).bridge;
  // Settings that read at once, so a refusal in the block can only be the updater's.
  const bridge: PlatformBridge = {
    ...fixture,
    update: updater,
    machineSettings: machineSettingsUnreadable(0),
  };
  let rendered: ReturnType<typeof render> | undefined;
  await act(async () => {
    rendered = render(
      <PlatformBridgeProvider bridge={bridge}>
        <LiveAnnouncerProvider>
          <GeneralPageOnUpdater bridge={bridge} updater={updater} />
        </LiveAnnouncerProvider>
      </PlatformBridgeProvider>,
    );
    await crossMacrotaskBoundary();
    await crossMacrotaskBoundary();
  });
  const block = (rendered as ReturnType<typeof render>).container.querySelector<HTMLElement>(
    'section[aria-label="Application updates"]',
  );
  if (block === null) {
    throw new Error("the General page drew no update block");
  }
  return { block, runningVersion: bridge.app.version };
}
