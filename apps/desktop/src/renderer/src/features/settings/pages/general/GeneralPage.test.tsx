// The application page prints the build facts the bridge reports and claims one section.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { unscriptedScenario } from "@test/helpers/fixture-bridge.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { GeneralPage } from "./GeneralPage.js";
import { composeSettingsPages } from "../../settings-pages.js";
import type { SettingsPageContext } from "../../types.js";
import { testUiStateStore } from "@test/helpers/settings-page-mount.js";
import { UNREPORTED_MAIN_PROCESS_STATE } from "@renderer/store/window/main-process-state.js";

const SCENARIO = unscriptedScenario("application-page-test");

/**
 * A settings context over the shipped fixture bridge, with the build facts replaced.
 *
 * The build facts are overridden deliberately and not inherited: the fixture pins
 * `0.0.0-fixture` so a screenshot baseline does not move with the machine, and the
 * negative control below reads exactly that string to prove the panel prints what the
 * bridge said rather than a constant of its own.
 */
function contextFor(): SettingsPageContext {
  const fixture = createFixtureBridge({ scenario: SCENARIO });
  return {
    bridge: {
      ...fixture,
      desktopBridge: {
        ...fixture.desktopBridge,
        app: { version: "1.4.0", platform: "darwin", arch: "arm64", locale: "en-GB" },
      },
    },
    openPage: () => undefined,
    retainedSessionId: undefined,
    retainedSessionStore: undefined,
    shellState: UNREPORTED_MAIN_PROCESS_STATE,
    selection: undefined,
    uiStateStore: testUiStateStore(),
    chooseScheme: () => undefined,
  };
}

describe("application page", () => {
  it("renders the build facts verbatim off the bridge", () => {
    const text = render(<GeneralPage context={contextFor()} />).container.textContent ?? "";
    expect(text).toContain("1.4.0");
    expect(text).toContain("darwin");
    expect(text).toContain("arm64");
    expect(text).toContain("en-GB");
  });

  it("negative control: the facts are the bridge's and not a placeholder", () => {
    // Without this, the first case would pass over a page that printed a fixed
    // version string — which is exactly what a build-facts panel must never do.
    const text = render(<GeneralPage context={contextFor()} />).container.textContent ?? "";
    expect(text).not.toContain("0.0.0");
  });

  it("claims the application section with a search vocabulary", () => {
    const registry = composeSettingsPages();
    const descriptor = registry.descriptorFor("general");
    expect(descriptor?.label).toBe("General");
    expect(descriptor?.keywords).toContain("updates");
  });
});
