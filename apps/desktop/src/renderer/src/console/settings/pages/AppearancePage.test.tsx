// The appearance page projects the applied scheme, chooses through the frame's own
// registered commands, and offers nothing else.

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AppearancePage, registerAppearancePage } from "./AppearancePage.js";
import { consoleCommands } from "../../frame/command-surface.js";
import { SCHEME_ATTRIBUTE } from "../../tokens/index.js";
import { SettingsPageRegistry } from "../settings-page-registry.js";

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
  it("offers exactly the three modes and no fourth control", () => {
    const { container } = render(<AppearancePage />);
    const optionLabels = [...container.querySelectorAll(".meridian-scheme-choice__label")].map(
      (element) => element.textContent ?? "",
    );
    expect(optionLabels).toStrictEqual(["Follow this machine", "Light", "Dark"]);
  });

  it("shows the applied attribute as the current choice", () => {
    document.documentElement.setAttribute(SCHEME_ATTRIBUTE, "dark");
    const { container } = render(<AppearancePage />);
    const checked = [...container.querySelectorAll(".meridian-scheme-choice__option")].filter(
      (option) => option.querySelector("[data-checked]") !== null,
    );
    expect(checked).toHaveLength(1);
    expect(checked[0]?.textContent ?? "").toContain("Dark");
  });

  it("treats an absent attribute as following the machine", () => {
    // The frame encodes `system` by REMOVING the attribute, so a page that read an
    // absent attribute as "no choice" would show nothing current on a default install.
    const { container } = render(<AppearancePage />);
    const checked = [...container.querySelectorAll(".meridian-scheme-choice__option")].filter(
      (option) => option.querySelector("[data-checked]") !== null,
    );
    expect(checked[0]?.textContent ?? "").toContain("Follow this machine");
  });

  it("says so when the document carries a scheme it does not define", () => {
    document.documentElement.setAttribute(SCHEME_ATTRIBUTE, "sepia");
    const { container } = render(<AppearancePage />);
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
      const { container } = render(<AppearancePage />);
      const darkControl = [...container.querySelectorAll(".meridian-scheme-choice__option")]
        .find((option) => (option.textContent ?? "").includes("Dark"))
        ?.querySelector("input");
      await act(async () => {
        (darkControl as HTMLElement | null)?.click();
        await Promise.resolve();
      });
      expect(chosen).toStrictEqual(["frame.useDarkScheme"]);
    } finally {
      unregister();
    }
  });

  it("renders a refusal when this window has no such command registered", async () => {
    // The negative control for the arm above: with nothing registered, the page must
    // say the scheme did not change rather than appear to have applied it.
    const { container } = render(<AppearancePage />);
    const lightControl = [...container.querySelectorAll(".meridian-scheme-choice__option")]
      .find((option) => (option.textContent ?? "").includes("Light"))
      ?.querySelector("input");
    await act(async () => {
      (lightControl as HTMLElement | null)?.click();
      await Promise.resolve();
    });
    expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();
    expect(container.textContent ?? "").toContain("scheme-command-unavailable");
  });

  it("claims the appearance section with a search vocabulary", () => {
    const registry = new SettingsPageRegistry();
    registerAppearancePage(registry);
    const descriptor = registry.descriptorFor("appearance");
    expect(descriptor?.label).toBe("Appearance");
    expect(descriptor?.keywords).toContain("theme");
  });
});
