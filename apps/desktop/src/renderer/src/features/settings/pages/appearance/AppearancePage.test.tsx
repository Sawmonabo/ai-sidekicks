// The appearance page projects the applied scheme and chooses through the frame's own
// registered commands.
//
// The page reads no wire and holds no store, so the mount needs nothing beside it.

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AppearancePage } from "./AppearancePage.js";
import { consoleCommands } from "@renderer/console/palette/index.js";
import { SCHEME_ATTRIBUTE } from "@renderer/styles/generate-css.js";
import { composeSettingsPages } from "../../settings-pages.js";

/** Mount the page and let its first effects land before anything is asserted. */
async function renderAppearancePage(): Promise<HTMLElement> {
  const { container } = render(<AppearancePage />);
  await act(async () => {
    await crossMacrotaskBoundary();
  });
  return container;
}

/** The three acts the frame registers per window, as this test's stand-ins record them. */
const SCHEME_COMMAND_IDS = [
  "frame.useSystemScheme",
  "frame.useLightScheme",
  "frame.useDarkScheme",
] as const;

/**
 * Register the three scheme commands against the REAL registry the page invokes.
 *
 * The page is driven through the registry rather than through an injected callback
 * on purpose, so the test registers the same ids the frame does and records which
 * one ran. What is stubbed is the ACT — a window-local closure over a store this
 * test has no frame for — never the registry, which is the module under test's
 * collaborator and is the real one.
 */
function registerRecordingSchemeCommands(chosen: string[]): () => void {
  for (const commandId of SCHEME_COMMAND_IDS) {
    consoleCommands.register({
      id: commandId,
      title: commandId,
      group: "Appearance",
      run: () => {
        chosen.push(commandId);
      },
    });
  }
  return () => {
    for (const commandId of SCHEME_COMMAND_IDS) {
      consoleCommands.unregister(commandId);
    }
  };
}

afterEach(() => {
  document.documentElement.removeAttribute(SCHEME_ATTRIBUTE);
});

describe("appearance page", () => {
  it("offers exactly the three modes and no fourth control", async () => {
    const container = await renderAppearancePage();
    const optionLabels = [...container.querySelectorAll(".meridian-scheme-choice__label")].map(
      (element) => element.textContent ?? "",
    );
    expect(optionLabels).toStrictEqual(["Follow this machine", "Light", "Dark"]);
  });

  it("shows the applied attribute as the current choice", async () => {
    document.documentElement.setAttribute(SCHEME_ATTRIBUTE, "dark");
    const container = await renderAppearancePage();
    const checked = [...container.querySelectorAll(".meridian-scheme-choice__option")].filter(
      (option) => option.querySelector("[data-checked]") !== null,
    );
    expect(checked).toHaveLength(1);
    expect(checked[0]?.textContent ?? "").toContain("Dark");
  });

  it("treats an absent attribute as following the machine", async () => {
    // The frame encodes `system` by REMOVING the attribute, so a page that read an
    // absent attribute as "no choice" would show nothing current on a default install.
    const container = await renderAppearancePage();
    const checked = [...container.querySelectorAll(".meridian-scheme-choice__option")].filter(
      (option) => option.querySelector("[data-checked]") !== null,
    );
    expect(checked[0]?.textContent ?? "").toContain("Follow this machine");
  });

  it("says so when the document carries a scheme it does not define", async () => {
    document.documentElement.setAttribute(SCHEME_ATTRIBUTE, "sepia");
    const container = await renderAppearancePage();
    expect(container.querySelector(".meridian-nothing--error")).not.toBeNull();
    expect(
      [...container.querySelectorAll(".meridian-scheme-choice__option")].filter(
        (option) => option.querySelector("[data-checked]") !== null,
      ),
    ).toHaveLength(0);
  });

  it("runs the frame's registered command when a mode is chosen", async () => {
    const chosen: string[] = [];
    const unregister = registerRecordingSchemeCommands(chosen);
    try {
      const container = await renderAppearancePage();
      const darkControl = [...container.querySelectorAll(".meridian-scheme-choice__option")]
        .find((option) => (option.textContent ?? "").includes("Dark"))
        ?.querySelector("input");
      await act(async () => {
        (darkControl as HTMLElement | null)?.click();
        await crossMacrotaskBoundary();
      });
      expect(chosen).toStrictEqual(["frame.useDarkScheme"]);
    } finally {
      unregister();
    }
  });

  it("renders a refusal when this window has no such command registered", async () => {
    // The negative control for the arm above: with nothing registered, the page must
    // say the scheme did not change rather than appear to have applied it.
    const container = await renderAppearancePage();
    const lightControl = [...container.querySelectorAll(".meridian-scheme-choice__option")]
      .find((option) => (option.textContent ?? "").includes("Light"))
      ?.querySelector("input");
    await act(async () => {
      (lightControl as HTMLElement | null)?.click();
      await crossMacrotaskBoundary();
    });
    expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();
    expect(container.textContent ?? "").toContain("scheme-command-unavailable");
  });

  it("claims the appearance section with a search vocabulary", () => {
    const registry = composeSettingsPages();
    const descriptor = registry.descriptorFor("appearance");
    expect(descriptor?.label).toBe("Appearance");
    expect(descriptor?.keywords).toContain("theme");
  });
});
