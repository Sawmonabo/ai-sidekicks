// The appearance page projects the applied scheme and chooses through the window's act. It
// reads no wire and holds no store.

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AppearancePage } from "./AppearancePage.js";
import { SCHEME_ATTRIBUTE } from "@renderer/styles/generate-css.js";
import type { SchemePreference } from "@renderer/styles/tokens.js";
import { composeSettingsPages } from "../../settings-pages.js";

/** Mount the page and let its first effects land before anything is asserted. */
async function renderAppearancePage(
  chooseScheme: (preference: SchemePreference) => void = () => undefined,
): Promise<HTMLElement> {
  const { container } = render(<AppearancePage chooseScheme={chooseScheme} />);
  await act(async () => {
    await crossMacrotaskBoundary();
  });
  return container;
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
    // The frame encodes `system` by removing the attribute, so reading absence as "no choice"
    // would show nothing current on a default install.
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

  it("chooses the mode a person picks through the window's act", async () => {
    const chosen: SchemePreference[] = [];
    const container = await renderAppearancePage((preference) => {
      chosen.push(preference);
    });
    const darkControl = [...container.querySelectorAll(".meridian-scheme-choice__option")]
      .find((option) => (option.textContent ?? "").includes("Dark"))
      ?.querySelector("input");
    await act(async () => {
      (darkControl as HTMLElement | null)?.click();
      await crossMacrotaskBoundary();
    });
    expect(chosen).toStrictEqual(["dark"]);
  });

  it("claims the appearance section with a search vocabulary", () => {
    const registry = composeSettingsPages();
    const descriptor = registry.descriptorFor("appearance");
    expect(descriptor?.label).toBe("Appearance");
    expect(descriptor?.keywords).toContain("theme");
  });
});
