// The application page composes the two blocks about this build and claims one
// section for them.

import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "../../../core/index.js";
import { LiveAnnouncer, LiveAnnouncerProvider } from "../../../primitives/index.js";
import {
  fixtureBridgeWithGrowth,
  growthRefusing,
  unscriptedScenario,
} from "../../../bridge/fixture/fixture-bridge.test-support.js";
import { ApplicationPage, registerApplicationPage } from "./ApplicationPage.js";
import { SettingsPageRegistry, type SettingsPageContext } from "../../settings-page-registry.js";
import { UNREPORTED_SHELL_STATE } from "../../../store/index.js";

const SCENARIO = unscriptedScenario("application-page-test");

/**
 * A settings context over the shipped fixture bridge, with three seams replaced.
 *
 * The build facts are overridden deliberately and not inherited: the fixture pins
 * `0.0.0-fixture` so a screenshot baseline does not move with the machine, and the
 * negative control below reads exactly that string to prove the panel prints what the
 * bridge said rather than a constant of its own.
 */
function contextFor(): SettingsPageContext {
  const fixture = fixtureBridgeWithGrowth(SCENARIO, {
    shellConfigRead: growthRefusing("shellConfigRead"),
    shellConfigWrite: growthRefusing("shellConfigWrite"),
  });
  return {
    bridge: {
      ...fixture,
      sidekicks: {
        ...fixture.sidekicks,
        app: { version: "1.4.0", platform: "darwin", arch: "arm64", locale: "en-GB" },
        update: {
          getState: () => Promise.resolve({ status: "idle" as const }),
          subscribe: () => () => undefined,
          requestCheck: () => Promise.resolve(),
          requestRestart: () => Promise.resolve(),
        },
      },
    },
    openSection: () => undefined,
    retainedSessionId: undefined,
    retainedSessionStore: undefined,
    shellState: UNREPORTED_SHELL_STATE,
  };
}

/**
 * Mount the page under the console's real announcer and let both blocks settle.
 *
 * The provider is here because the updates block announces its settlement and
 * `useAnnounce` refuses to be called without one — which is the wiring bug that
 * primitive exists to make loud rather than silent. The PAGE element is returned
 * rather than the render container, so the announcer's two regions never land inside
 * an assertion about what this page rendered.
 */
async function renderSettled(): Promise<HTMLElement> {
  const announcer = new LiveAnnouncer({ clock: new ManualClock() });
  let root: HTMLElement | undefined;
  await act(async () => {
    root = render(
      <LiveAnnouncerProvider announcer={announcer}>
        <ApplicationPage context={contextFor()} />
      </LiveAnnouncerProvider>,
    ).container;
    await crossMacrotaskBoundary();
    await crossMacrotaskBoundary();
  });
  const page = (root as HTMLElement).querySelector<HTMLElement>(".meridian-settings-page");
  if (page === null) {
    throw new Error("the application page did not render");
  }
  return page;
}

describe("application page", () => {
  it("renders the build facts verbatim off the bridge", async () => {
    const container = await renderSettled();
    const text = container.textContent ?? "";
    expect(text).toContain("1.4.0");
    expect(text).toContain("darwin");
    expect(text).toContain("arm64");
    expect(text).toContain("en-GB");
  });

  it("holds both blocks the section set has no room to separate", async () => {
    const container = await renderSettled();
    const blocks = [...container.querySelectorAll(".meridian-settings-page__block-title")].map(
      (element) => element.textContent ?? "",
    );
    expect(blocks).toStrictEqual(["Updates", "Crash reporting"]);
  });

  it("negative control: the facts are the bridge's and not a placeholder", async () => {
    // Without this, the first case would pass over a page that printed a fixed
    // version string — which is exactly what a build-facts panel must never do.
    const container = await renderSettled();
    expect(container.textContent ?? "").not.toContain("0.0.0");
  });

  it("claims the application section with a search vocabulary reaching both blocks", () => {
    const registry = new SettingsPageRegistry();
    registerApplicationPage(registry);
    const descriptor = registry.descriptorFor("application");
    expect(descriptor?.label).toBe("Application");
    expect(descriptor?.keywords).toContain("updates");
    expect(descriptor?.keywords).toContain("crash reporting");
  });
});
