// The address guard and the close-tab chord each have one catastrophic failure: a page navigated
// to a local file, and a chord that closes the window instead of a tab.

import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HOST_CHORD_PLATFORM } from "#renderer/lib/chord-format.js";
import {
  addressField,
  findRefusalBanner,
  queryRefusalBanner,
  recordingActs,
  renderPreviewPane,
} from "./PreviewPane.test-support.js";

/** The platform modifier that closes a tab, as an event initializer. */
const CLOSE_TAB_MODIFIER = HOST_CHORD_PLATFORM === "darwin" ? { metaKey: true } : { ctrlKey: true };

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

  it("lets an ordinary keystroke through to the page", async () => {
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
