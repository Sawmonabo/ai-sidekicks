// The refusal is never suppressed, and the handoff never becomes an act.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { refuse } from "../../../core/index.js";
import { AccountPlaneRefusal } from "./AccountPlaneRefusal.js";

afterEach(() => {
  cleanup();
});

function renderRefusal(
  code: string,
  currentSection?: Parameters<typeof AccountPlaneRefusal>[0]["currentSection"],
): { readonly container: HTMLElement; readonly openSection: ReturnType<typeof vi.fn> } {
  const openSection = vi.fn();
  const { container } = render(
    <AccountPlaneRefusal
      refusal={refuse("provider-account", code, "The daemon's own sentence, unchanged.")}
      openSection={openSection}
      currentSection={currentSection}
    />,
  );
  return { container, openSection };
}

describe("an account-plane refusal on a console surface", () => {
  it("renders the daemon's code and sentence before anything it adds", () => {
    const { container } = renderRefusal("provideraccount.not_registered");
    const text = container.textContent ?? "";
    expect(text.indexOf("provideraccount.not_registered")).toBeLessThan(
      text.indexOf("Registering one closes this."),
    );
    expect(text).toContain("The daemon's own sentence, unchanged.");
  });

  it("offers one navigation, and moving is all pressing it does", () => {
    const { container, openSection } = renderRefusal("provideraccount.no_default");
    const actions = container.querySelectorAll<HTMLButtonElement>(
      ".meridian-account-handoff__action",
    );
    expect(actions).toHaveLength(1);
    actions[0]?.click();
    expect(openSection.mock.calls).toStrictEqual([["accounts"]]);
  });

  it("says what has to happen without offering to open the page it is already on", () => {
    const { container } = renderRefusal("provideraccount.no_default", "accounts");
    expect(container.textContent ?? "").toContain("Choosing which account answers");
    expect(container.querySelector(".meridian-account-handoff__action")).toBeNull();
  });

  it("negative control: a code no console act closes renders the refusal alone", () => {
    const { container } = renderRefusal("provideraccount.permission_denied");
    expect(container.textContent ?? "").toContain("provideraccount.permission_denied");
    expect(container.querySelector(".meridian-account-handoff")).toBeNull();
  });

  it("negative control: a refusal from another namespace adds nothing", () => {
    const { container } = renderRefusal("growth-port.unavailable");
    expect(container.textContent ?? "").toContain("growth-port.unavailable");
    expect(container.querySelector(".meridian-account-handoff")).toBeNull();
  });
});
