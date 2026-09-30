// The chrome never claims more than the view reported: with no reported state every history
// control is disabled. The address guard and the close-tab chord get adversarial cases because
// each has one catastrophic failure: a page navigated to a local file, and a chord that closes
// the window instead of a tab.

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HOST_CHORD_PLATFORM } from "@renderer/lib/chord-format.js";
import {
  addressField,
  findRefusalBanner,
  queryRefusalBanner,
  recordingActs,
  renderPreviewPane,
} from "./PreviewPane.test-support.js";

/** The platform modifier that closes a tab, as an event initializer. */
const CLOSE_TAB_MODIFIER = HOST_CHORD_PLATFORM === "darwin" ? { metaKey: true } : { ctrlKey: true };

describe("preview pane chrome", () => {
  it("is named by the trail it sits on rather than by its kind alone", async () => {
    // `aria-labelledby`, never `aria-label`: the pane frame names a pane by its whole address so
    // two preview panes are told apart. This mount has no session, so the trail opens on the
    // no-address crumb.
    const { region } = await renderPreviewPane();
    const crumbs = document.getElementById(region.getAttribute("aria-labelledby") ?? "");

    expect(region.getAttribute("aria-label")).toBeNull();
    expect(crumbs?.textContent).toBe("No sessionPreview");
  });

  it("disables every history control while no state has been reported", async () => {
    await renderPreviewPane();
    expect(screen.getByRole("button", { name: "Back" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Forward" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Reload" })).toHaveProperty("disabled", true);
  });

  it("keeps the escape to the system browser live, because it is the fallback", async () => {
    await renderPreviewPane();
    expect(screen.getByRole("button", { name: /Open externally/u })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("shows the reload arm, not the stop arm, with no load in flight", async () => {
    await renderPreviewPane();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
});

describe("preview pane address field", () => {
  it("refuses a filesystem destination without dispatching a navigation", async () => {
    const navigations: string[] = [];
    await renderPreviewPane(undefined, recordingActs(navigations));
    const field = addressField();
    fireEvent.change(field, { target: { value: "/etc/hosts" } });
    fireEvent.submit(field.closest("form") as HTMLFormElement);
    expect(navigations).toStrictEqual([]);
    expect((await findRefusalBanner()).textContent).toContain("takes web destinations only");
    // The draft survives the refusal, because the person has to be able to fix it.
    expect(addressField().value).toBe("/etc/hosts");
  });

  it("negative control: a web destination does reach the navigate act", async () => {
    // Without this, a guard that refused every destination would satisfy the case above.
    const navigations: string[] = [];
    await renderPreviewPane(undefined, recordingActs(navigations));
    const field = screen.getByLabelText("Destination");
    fireEvent.change(field, { target: { value: "https://example.invalid/page" } });
    fireEvent.submit(field.closest("form") as HTMLFormElement);
    expect(navigations).toStrictEqual(["https://example.invalid/page"]);
    expect(queryRefusalBanner()).toBeNull();
  });
});

describe("preview pane close-tab chord", () => {
  it("swallows the platform chord, so it cannot reach the window and close it", async () => {
    const { region } = await renderPreviewPane();
    const event = new KeyboardEvent("keydown", {
      key: "w",
      code: "KeyW",
      bubbles: true,
      cancelable: true,
      ...CLOSE_TAB_MODIFIER,
    });
    fireEvent(region, event);
    expect(event.defaultPrevented).toBe(true);
    expect((await findRefusalBanner()).textContent).toContain("could not close this window");
  });

  it("negative control: an ordinary keystroke passes through untouched", async () => {
    // A capture handler that prevented every default would swallow the page's own typing.
    const { region } = await renderPreviewPane();
    const event = new KeyboardEvent("keydown", {
      key: "w",
      code: "KeyW",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(region, event);
    expect(event.defaultPrevented).toBe(false);
    expect(queryRefusalBanner()).toBeNull();
  });
});
