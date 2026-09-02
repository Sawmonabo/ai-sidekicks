// What the address field says the page is, against what the page says it is.
//
// One field, two jobs that pull opposite ways: it reports where the page is, and it
// takes where a person wants to go. Held as a single string it can only do the
// second, and the first fails silently — the chrome keeps asserting the destination
// somebody submitted while the page is somewhere else, submitting it again goes back
// there, and the location the page is actually on can be neither selected nor copied.
//
// So every case below names both inputs at once: which state the field is in, and
// what the view has reported since. The submit and Escape cases are the controls —
// each is the exact moment the old single-string field stopped following and never
// started again.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  addressField,
  findRefusalBanner,
  navigationReportingBridge,
  renderBrowserPane,
  reportedState,
} from "./BrowserPane.test-support.js";

describe("browser pane address field follows reported navigation", () => {
  const FIRST = "https://example.invalid/page";
  const AFTER_REDIRECT = "https://example.invalid/after-redirect";

  it("shows the reported URL, so the current location is selectable and copyable", async () => {
    const { bridge, report } = navigationReportingBridge();
    await renderBrowserPane(bridge);
    report(reportedState(FIRST));
    await waitFor(() => {
      expect(addressField().value).toBe(FIRST);
    });
  });

  it("follows a redirect the page took on its own", async () => {
    const { bridge, report } = navigationReportingBridge();
    await renderBrowserPane(bridge);
    report(reportedState(FIRST));
    await waitFor(() => {
      expect(addressField().value).toBe(FIRST);
    });
    report(reportedState(AFTER_REDIRECT));
    await waitFor(() => {
      expect(addressField().value).toBe(AFTER_REDIRECT);
    });
  });

  it("holds a draft against a navigation that lands mid-edit", async () => {
    const { bridge, report } = navigationReportingBridge();
    await renderBrowserPane(bridge);
    report(reportedState(FIRST));
    await waitFor(() => {
      expect(addressField().value).toBe(FIRST);
    });
    fireEvent.change(addressField(), { target: { value: "example.invalid/half-typ" } });
    // The second reading carries `canGoBack`, so the Back control is the witness that
    // it actually landed — otherwise this case would pass against a stream that
    // delivered nothing at all.
    report(reportedState(AFTER_REDIRECT, { canGoBack: true }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Back" })).toHaveProperty("disabled", false);
    });
    expect(addressField().value).toBe("example.invalid/half-typ");
  });

  it("returns to following on submit, so a refused navigation shows where the page is", async () => {
    // The old field kept the submitted string forever. Here the navigation is
    // refused — every navigation is, until the browser namespace is registered — and
    // the field goes back to reporting the location the page never left.
    const { bridge, report } = navigationReportingBridge();
    await renderBrowserPane(bridge);
    report(reportedState(FIRST));
    await waitFor(() => {
      expect(addressField().value).toBe(FIRST);
    });
    fireEvent.change(addressField(), { target: { value: "example.invalid/typed" } });
    fireEvent.submit(addressField().closest("form") as HTMLFormElement);
    await waitFor(() => {
      expect(addressField().value).toBe(FIRST);
    });
    expect((await findRefusalBanner()).textContent).toContain("wire-unregistered");
  });

  it("returns to following on Escape, which abandons the edit", async () => {
    const { bridge, report } = navigationReportingBridge();
    await renderBrowserPane(bridge);
    report(reportedState(FIRST));
    await waitFor(() => {
      expect(addressField().value).toBe(FIRST);
    });
    fireEvent.change(addressField(), { target: { value: "example.invalid/abandoned" } });
    expect(addressField().value).toBe("example.invalid/abandoned");
    fireEvent.keyDown(addressField(), { key: "Escape" });
    expect(addressField().value).toBe(FIRST);
  });

  it("negative control: with nothing reported the field is empty and takes typing", async () => {
    // Every case above would hold vacuously against a field that ignored the person
    // entirely and only ever mirrored the wire — which would make the chrome unable
    // to navigate anywhere at all.
    await renderBrowserPane();
    expect(addressField().value).toBe("");
    expect(addressField().placeholder).toBe("Type a destination");
    fireEvent.change(addressField(), { target: { value: "example.invalid" } });
    expect(addressField().value).toBe("example.invalid");
  });
});
