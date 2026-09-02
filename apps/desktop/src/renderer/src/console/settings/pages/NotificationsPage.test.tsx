// The notifications page offers one global mute, says the preference set was never
// read, and never suggests a per-session tier.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NotificationsPage, registerNotificationsPage } from "./NotificationsPage.js";
import { SettingsPageRegistry, type SettingsPageContext } from "../settings-page-registry.js";

const CARRIER_UNAVAILABLE = {
  status: "unavailable",
  code: "wire-unregistered",
  detail: "Not checked — the shell-config preference carrier is not registered yet.",
  origin: "growth-port",
};

function contextWithRefusingCarrier(): SettingsPageContext {
  return {
    bridge: {
      source: "fixture",
      growth: {
        shellConfigRead: () => Promise.resolve(CARRIER_UNAVAILABLE),
        shellConfigWrite: () => Promise.resolve(CARRIER_UNAVAILABLE),
      },
    },
    openSection: () => undefined,
    activeSessionId: undefined,
  } as unknown as SettingsPageContext;
}

describe("notifications page", () => {
  it("says the preference set was not read rather than showing defaults as answers", () => {
    const { container } = render(<NotificationsPage context={contextWithRefusingCarrier()} />);
    expect(container.textContent ?? "").toContain("has not been read");
  });

  it("promises that in-app attention survives a muted desktop", () => {
    const { container } = render(<NotificationsPage context={contextWithRefusingCarrier()} />);
    expect(container.textContent ?? "").toContain("Muting the desktop never mutes the console");
  });

  it("negative control: it offers no per-session tier anywhere", () => {
    // The section forbids implying one exists, and the cheapest way that would
    // arrive is a control labelled with a session. This fails the moment one does.
    const { container } = render(<NotificationsPage context={contextWithRefusingCarrier()} />);
    const controlLabels = [...container.querySelectorAll(".meridian-settings-row__label")].map(
      (element) => element.textContent ?? "",
    );
    expect(controlLabels).toHaveLength(1);
    expect(controlLabels[0]).toContain("this machine");
  });

  it("holds the mute in this window when no carrier takes it", async () => {
    const { container } = render(<NotificationsPage context={contextWithRefusingCarrier()} />);
    const control = container.querySelector(".meridian-settings-row__switch");
    await act(async () => {
      (control as HTMLElement | null)?.click();
      await Promise.resolve();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Held in this window");
    expect(
      container.querySelector(".meridian-settings-row__switch")?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("claims the notifications section with a search vocabulary", () => {
    const registry = new SettingsPageRegistry();
    registerNotificationsPage(registry);
    const descriptor = registry.descriptorFor("notifications");
    expect(descriptor?.label).toBe("Notifications");
    expect(descriptor?.keywords).toContain("mute");
  });
});
