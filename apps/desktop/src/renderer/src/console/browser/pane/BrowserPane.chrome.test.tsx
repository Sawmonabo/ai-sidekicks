// The chrome's density rule, counted rather than claimed.
//
// `Spec-023 §Console Design (Meridian)` 12.1 fixes the number: six controls plus the
// address field are visible and everything else is one click behind the overflow. A
// rule about how many things are on screen is exactly the kind that erodes one control
// at a time, so it is asserted as a count over the rendered tree, and the second half
// — that the controls it names are BEHIND the disclosure rather than absent — is
// asserted beside it. Either half alone passes while the other is broken.

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { fixtureBrowserBridge, mountBrowserPaneForSubject } from "./BrowserPane.test-support.js";

/** The chrome row itself, which is the region the density rule is about. */
function chromeRow(): HTMLElement {
  const row = document.querySelector(".meridian-browser-chrome");
  if (!(row instanceof HTMLElement)) {
    throw new Error("the pane rendered no chrome row");
  }
  return row;
}

/** The overflow disclosure's body, which is where the rest of the controls live. */
function overflowBody(): HTMLElement {
  const body = document.querySelector(".meridian-browser-pane__overflow-body");
  if (!(body instanceof HTMLElement)) {
    throw new Error("the pane rendered no overflow body");
  }
  return body;
}

describe("the browser pane's control density", () => {
  it("shows six controls and the address field, and no more", async () => {
    await mountBrowserPaneForSubject(fixtureBrowserBridge(), "pane-density");
    const row = chromeRow();
    expect(within(row).getAllByRole("button")).toHaveLength(4);
    expect(within(row).getByLabelText("Destination")).toBeDefined();
    // The other two of the six are the tab strip's new-page control and the overflow
    // disclosure itself, both outside the address form and both on screen.
    expect(screen.getByRole("button", { name: "New page" })).toBeDefined();
    expect(screen.getByText("More")).toBeDefined();
  });

  it("puts the page picker, capture, pick element, and site data behind the overflow", async () => {
    await mountBrowserPaneForSubject(fixtureBrowserBridge(), "pane-overflow");
    const body = overflowBody();
    for (const label of ["Capture", "Pick element", "Clear site data", "Open file"]) {
      expect(within(body).getByRole("button", { name: label })).toBeDefined();
    }
    // And they are BEHIND it: the disclosure is closed, which is what "one click away"
    // means. A control rendered outside a closed `details` would satisfy every query
    // above while breaking the rule the queries are here to check.
    const disclosure = body.closest("details");
    expect(disclosure?.open).toBe(false);
  });

  it("names every region inside the overflow rather than piling the controls", async () => {
    await mountBrowserPaneForSubject(fixtureBrowserBridge(), "pane-regions");
    const heads = within(overflowBody())
      .getAllByRole("heading")
      .map((heading) => heading.textContent);
    expect(heads).toStrictEqual([
      "Pages",
      "This page",
      "Local files",
      "Produced objects",
      "Agent tool calls",
      "Keyboard handback",
      "Site data",
    ]);
  });
});

describe("the browser pane's load hairline", () => {
  it("renders nothing while no page is loading", async () => {
    await mountBrowserPaneForSubject(fixtureBrowserBridge(), "pane-hairline");
    expect(document.querySelector(".meridian-browser-hairline")).toBeNull();
  });
});
