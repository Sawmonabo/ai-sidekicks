// What the operating system allows, said by the permission notice from each reading it can be
// handed: a refusal is named, with the promise that attention inside the app survives it.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotificationPermissionNotice } from "./NotificationPermissionNotice.js";

describe("the notification permission notice — what the operating system allows", () => {
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
