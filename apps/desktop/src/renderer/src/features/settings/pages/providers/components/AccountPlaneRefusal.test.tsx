// The refusal is never suppressed, and the handoff never becomes an act.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { refuse } from "@renderer/lib/refusal.js";
import { AccountPlaneRefusal } from "./AccountPlaneRefusal.js";

afterEach(() => {
  cleanup();
});

function renderRefusal(
  code: string,
  currentSection?: Parameters<typeof AccountPlaneRefusal>[0]["currentSection"],
): { readonly container: HTMLElement; readonly openPage: ReturnType<typeof vi.fn> } {
  const openPage = vi.fn();
  const { container } = render(
    <AccountPlaneRefusal
      refusal={refuse("provider-account", code, "The daemon's own sentence, unchanged.")}
      openPage={openPage}
      currentSection={currentSection}
    />,
  );
  return { container, openPage };
}

describe("an account-plane refusal on a console screen", () => {
  it("renders the daemon's code and sentence before anything it adds", () => {
    const { container } = renderRefusal("provideraccount.not_registered");
    const text = container.textContent ?? "";
    expect(text.indexOf("provideraccount.not_registered")).toBeLessThan(
      text.indexOf("Registering one closes this."),
    );
    expect(text).toContain("The daemon's own sentence, unchanged.");
  });

  it("offers one navigation, and moving is all pressing it does", () => {
    const { container, openPage } = renderRefusal("provideraccount.no_default");
    const actions = container.querySelectorAll<HTMLButtonElement>(
      ".meridian-account-handoff__action",
    );
    expect(actions).toHaveLength(1);
    actions[0]?.click();
    expect(openPage.mock.calls).toStrictEqual([["providers"]]);
  });
});
