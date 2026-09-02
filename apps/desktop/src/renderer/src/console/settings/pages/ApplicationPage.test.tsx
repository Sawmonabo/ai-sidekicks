// The application page composes the two blocks about this build and claims one
// section for them.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  fixtureBridgeWithGrowth,
  growthRefusing,
  unscriptedScenario,
} from "../../bridge/fixture-bridge-overrides.test-support.js";
import { ApplicationPage, registerApplicationPage } from "./ApplicationPage.js";
import { SettingsPageRegistry, type SettingsPageContext } from "../settings-page-registry.js";

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
    activeSessionId: undefined,
  };
}

async function renderSettled(): Promise<HTMLElement> {
  let container: HTMLElement | undefined;
  await act(async () => {
    container = render(<ApplicationPage context={contextFor()} />).container;
    await Promise.resolve();
    await Promise.resolve();
  });
  return container as HTMLElement;
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
