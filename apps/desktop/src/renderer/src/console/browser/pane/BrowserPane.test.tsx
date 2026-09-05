// The browser pane's chrome renders the absence that is true, and never a control
// that lies about what it can do.
//
// Two claims are held here, and both are about being wrong in the safe direction.
// Rule 8's: `not-checked` says nobody asked, `empty` says a read found none — a pane
// rendering `empty` would assert this session owns no pages, a fact no read
// established and one an agent's three background pages would contradict without
// changing a pixel. And 12.2's: the chrome never derives navigability, so with no
// reported state every history control is disabled rather than optimistically live.
//
// The address guard and the close-tab chord get adversarial cases rather than happy
// ones, because each has exactly one catastrophic failure — a page navigated to a
// local file, and a chord that closes the operator's window instead of a tab. What
// the field does ACROSS readings is its own suite next door, and so is what happens
// when a bridge call does not answer.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BROWSER_SCENARIO } from "../../bridge/scenarios/browser.js";
import { BudgetMeter } from "../BudgetMeter.js";
import { createFixtureBridge } from "../../bridge/index.js";
import { HOST_CHORD_PLATFORM } from "../../primitives/index.js";
import {
  addressField,
  findRefusalBanner,
  queryRefusalBanner,
  renderBrowserPane,
} from "./BrowserPane.test-support.js";

/** The platform modifier that closes a tab, as an event initializer. */
const CLOSE_TAB_MODIFIER = HOST_CHORD_PLATFORM === "darwin" ? { metaKey: true } : { ctrlKey: true };

describe("browser pane chrome", () => {
  it("names itself, so the pane is reachable by name", async () => {
    expect((await renderBrowserPane()).region.getAttribute("aria-label")).toBe("Browser");
  });

  it("disables every history control while no state has been reported", async () => {
    await renderBrowserPane();
    expect(screen.getByRole("button", { name: "Back" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Forward" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Reload" })).toHaveProperty("disabled", true);
  });

  it("keeps the escape to the system browser live, because it is the fallback", async () => {
    // The one control that must not be gated on the unbuilt namespace: it is what the
    // whole feature degrades to when nothing else in the chrome can act.
    await renderBrowserPane();
    expect(screen.getByRole("button", { name: /Open externally/u })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("shows the reload arm, not the stop arm, with no load in flight", async () => {
    await renderBrowserPane();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("renders the not-checked absence for the surfaces nobody has asked about", async () => {
    const { region } = await renderBrowserPane();
    const absences = [...region.querySelectorAll(".meridian-nothing")];
    expect(absences.length).toBeGreaterThan(0);
    for (const absence of absences) {
      expect(absence.className).toContain("meridian-nothing--not-checked");
    }
  });

  it("mounts the viewport's absence as a surface and the strip's as a badge", async () => {
    // Placement is named rather than left to the kind: a badge in place of a whole
    // viewport reads as a pane that failed to finish painting.
    const { region } = await renderBrowserPane();
    expect(region.querySelector(".meridian-nothing--block")).not.toBeNull();
    expect(region.querySelector(".meridian-nothing--badge")).not.toBeNull();
  });

  it("negative control: it never claims the session has no pages", async () => {
    // Every case above would pass over a pane that also, or instead, rendered the
    // absence that looks finished — which is the one thing this surface must not say.
    const { region } = await renderBrowserPane();
    expect(region.querySelector(".meridian-nothing--empty")).toBeNull();
    expect(region.textContent).not.toContain("No pages");
    // The badge carries its second sentence as a tooltip rather than as text, which
    // is what `inline` placement means — so the claim is read off the attribute.
    const badgeLabel = region.querySelector(".meridian-nothing__badge-label");
    expect(badgeLabel?.getAttribute("title")).toContain(
      "Nothing here says this session owns no pages",
    );
  });

  it("carries the resource ceiling one click away rather than on the surface", async () => {
    const { region } = await renderBrowserPane();
    const disclosure = region.querySelector("details");
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.textContent).toContain("Resource ceiling");
  });

  it("reports no figure for a ceiling nothing in this window meters", async () => {
    // The pane used to hand the meter a literal `VIEWS_MAX: 0`, which renders
    // through the same live-figure span a genuinely metered ceiling renders through
    // — so the ledger said this window holds zero browser views while the pane the
    // reader is looking at is one, and while no `browser.*` namespace exists to
    // count them. Every row takes the not-checked arm until something meters.
    const { region } = await renderBrowserPane();
    expect(boundReadingCell(region, "VIEWS_MAX")?.textContent).toContain("Not measured");
    expect(region.querySelector(".meridian-browser-bounds__reading")).toBeNull();
  });

  it("negative control: a metered ceiling does render its live figure", () => {
    // Without this the case above passes over a meter that renders no figure for
    // anything, which would make the not-checked assertion vacuous.
    const { container } = render(<BudgetMeter readings={{ VIEWS_MAX: 0 }} />);
    const reading = boundReadingCell(container, "VIEWS_MAX")?.querySelector(
      ".meridian-browser-bounds__reading",
    );
    expect(reading).not.toBeNull();
    expect(reading?.textContent).toContain("0");
  });
});

/** The `Now` cell of one bound's row, found by the row header the table names it in. */
function boundReadingCell(root: ParentNode, name: string): HTMLTableCellElement | null {
  const row = [...root.querySelectorAll("tr")].find(
    (candidate) => candidate.querySelector("th")?.textContent === name,
  );
  return row?.querySelectorAll("td")[1] ?? null;
}

describe("browser pane address field", () => {
  it("refuses a filesystem destination without dispatching a navigation", async () => {
    const bridge = createFixtureBridge({ scenario: BROWSER_SCENARIO });
    const navigate = vi.spyOn(bridge.growth, "browserNavigate");
    await renderBrowserPane(bridge);
    const field = addressField();
    fireEvent.change(field, { target: { value: "/etc/hosts" } });
    fireEvent.submit(field.closest("form") as HTMLFormElement);
    expect(navigate).not.toHaveBeenCalled();
    expect((await findRefusalBanner()).textContent).toContain("takes web destinations only");
    // The draft survives the refusal, because the person has to be able to fix it.
    expect(addressField().value).toBe("/etc/hosts");
  });

  it("negative control: a web destination does reach the port", async () => {
    // Without this, a guard that refused every destination would satisfy the case
    // above and would also make the address field inert.
    const bridge = createFixtureBridge({ scenario: BROWSER_SCENARIO });
    const navigate = vi.spyOn(bridge.growth, "browserNavigate");
    await renderBrowserPane(bridge);
    const field = screen.getByLabelText("Destination");
    fireEvent.change(field, { target: { value: "https://example.invalid/page" } });
    fireEvent.submit(field.closest("form") as HTMLFormElement);
    expect(navigate).toHaveBeenCalledWith({
      paneId: "pane-browser-1",
      url: "https://example.invalid/page",
    });
    // The port refuses it today, and the pane renders that refusal rather than
    // pretending the navigation happened.
    expect((await findRefusalBanner()).textContent).toContain("wire-unregistered");
  });
});

describe("browser pane rejected calls", () => {
  it("keeps the wire's own code when the navigation call rejects with an envelope", async () => {
    // A `permission_denied` and a torn-down preload are different next moves. The
    // pane used to flatten both into `navigation-call-failed`; the shared
    // normaliser keeps the code the other side sent and spends the pane's own
    // sentence only on a rejection that carries none.
    const bridge = createFixtureBridge({ scenario: BROWSER_SCENARIO });
    vi.spyOn(bridge.growth, "browserNavigate").mockRejectedValue({
      code: "permission_denied",
      message: "You may not navigate this pane.",
    });
    await renderBrowserPane(bridge);
    const field = addressField();
    fireEvent.change(field, { target: { value: "https://example.invalid/page" } });
    fireEvent.submit(field.closest("form") as HTMLFormElement);
    const banner = await findRefusalBanner();
    expect(banner.textContent).toContain("permission_denied");
    expect(banner.textContent).toContain("You may not navigate this pane.");
    expect(banner.textContent).not.toContain("navigation-call-failed");
  });

  it("negative control: a codeless rejection still takes the pane's own sentence", async () => {
    const bridge = createFixtureBridge({ scenario: BROWSER_SCENARIO });
    vi.spyOn(bridge.growth, "browserNavigate").mockRejectedValue(new Error("IPC channel closed"));
    await renderBrowserPane(bridge);
    const field = addressField();
    fireEvent.change(field, { target: { value: "https://example.invalid/page" } });
    fireEvent.submit(field.closest("form") as HTMLFormElement);
    const banner = await findRefusalBanner();
    expect(banner.textContent).toContain("navigation-call-failed");
    expect(banner.textContent).toContain("never answered");
  });
});

describe("browser pane close-tab chord", () => {
  it("swallows the platform chord, so it cannot reach the window and close it", async () => {
    const { region } = await renderBrowserPane();
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
    const { region } = await renderBrowserPane();
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
