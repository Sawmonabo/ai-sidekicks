// What the operating system allows, said by the permission notice from each reading it can be
// handed, and the page's rail entry.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotificationPermissionNotice } from "./components/NotificationPermissionNotice.js";
import { composeSettingsPages } from "../../settings-pages.js";

describe("the notifications page — what the operating system allows", () => {
  it("names a denied permission and promises in-app attention survives it", () => {
    const { container } = render(
      <NotificationPermissionNotice reading={{ kind: "read", state: "denied" }} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("not permitting desktop notifications");
    expect(text).toContain("still reaches the rail");
  });

  it("says nothing unless the machine denied", () => {
    for (const state of ["granted", "not-determined"] as const) {
      const { container } = render(
        <NotificationPermissionNotice reading={{ kind: "read", state }} />,
      );
      expect(container.textContent ?? "").toBe("");
    }
  });
});

describe("the notifications page — its rail entry", () => {
  it("claims the notifications section with a search vocabulary", () => {
    const registry = composeSettingsPages();
    const descriptor = registry.descriptorFor("notifications");
    expect(descriptor?.label).toBe("Notifications");
    expect(descriptor?.keywords).toContain("mute");
  });
});
