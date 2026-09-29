// The preview pane's chrome never presents a control that lies about what it can do: the
// chrome never derives navigability, so with no reported state every history control is
// disabled rather than optimistically live.
//
// The address guard and the close-tab chord get adversarial cases rather than happy
// ones, because each has exactly one catastrophic failure: a page navigated to a local
// file, and a chord that closes the operator's window instead of a tab. What the field
// does across readings is its own suite next door.

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HOST_CHORD_PLATFORM } from "@renderer/console/primitives/index.js";
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
    // Through `aria-labelledby` and never `aria-label`: `seats/PaneFrame` names
    // every pane by its whole address — the session it belongs to, then what the pane is
    // — so two preview panes in one deck are told apart. This mount addresses no session,
    // so the trail opens on the chrome's own no-address crumb.
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
    // The one control that stays enabled with no reported state: it is what the pane
    // falls back to when nothing else in the chrome can act.
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
    // Without this, a guard that refused every destination would satisfy the case
    // above and would also make the address field inert.
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
    // A capture handler that prevented every default would take the page's own
    // typing as well, which is the failure the modifier test exists to prevent.
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
