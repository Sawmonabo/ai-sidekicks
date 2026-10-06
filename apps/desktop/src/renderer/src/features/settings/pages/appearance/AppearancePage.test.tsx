// The appearance page projects the applied scheme and chooses through the window's act. It
// reads no wire and holds no store.

import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AppearancePage } from "./AppearancePage.js";
import { SCHEME_ATTRIBUTE } from "#shared/appearance.js";
import type { SchemePreference } from "#renderer/styles/tokens.js";

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
  it("treats an absent attribute as following the machine", async () => {
    // The frame encodes `system` by removing the attribute, so reading absence as "no choice"
    // would show nothing current on a default install.
    const container = await renderAppearancePage();
    const checked = [...container.querySelectorAll(".meridian-scheme-choice__option")].filter(
      (option) => option.querySelector("[data-checked]") !== null,
    );
    expect(checked[0]?.textContent ?? "").toContain("Follow this machine");
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
});
