// The application page prints the build facts the bridge reports and claims one section.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { unscriptedScenario } from "@renderer/console/bridge/fixture/call-plane/bridge.test-support.js";
import { createFixtureBridge } from "@renderer/console/bridge/fixture/call-plane/bridge.js";
import { ApplicationPage } from "./GeneralPage.js";
import { composeSettingsPages } from "../../settings-pages.js";
import type { SettingsPageContext } from "../../types.js";
import { consoleTestUiStateStore } from "@test/helpers/settings-page-mount.js";
import { UNREPORTED_SHELL_STATE } from "@renderer/store/window/main-process-state.js";

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
    openSection: () => undefined,
    retainedSessionId: undefined,
    retainedSessionStore: undefined,
    shellState: UNREPORTED_SHELL_STATE,
    selection: undefined,
    uiStateStore: consoleTestUiStateStore(),
  };
}

describe("application page", () => {
  it("renders the build facts verbatim off the bridge", () => {
    const text = render(<ApplicationPage context={contextFor()} />).container.textContent ?? "";
    expect(text).toContain("1.4.0");
    expect(text).toContain("darwin");
    expect(text).toContain("arm64");
    expect(text).toContain("en-GB");
  });

  it("negative control: the facts are the bridge's and not a placeholder", () => {
    // Without this, the first case would pass over a page that printed a fixed
    // version string — which is exactly what a build-facts panel must never do.
    const text = render(<ApplicationPage context={contextFor()} />).container.textContent ?? "";
    expect(text).not.toContain("0.0.0");
  });

  it("claims the application section with a search vocabulary", () => {
    const registry = composeSettingsPages();
    const descriptor = registry.descriptorFor("application");
    expect(descriptor?.label).toBe("General");
    expect(descriptor?.keywords).toContain("updates");
  });
});
