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
// local file, and a chord that closes the operator's window instead of a tab.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BROWSER_SCENARIO } from "../../bridge/scenarios/browser.js";
import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { DraftStore, UiStateStore } from "../../persistence/index.js";
import { HOST_CHORD_PLATFORM } from "../../primitives/index.js";
import { FrameStore } from "../../store/index.js";
import type { ConsolePaneContext } from "../../workspace/index.js";
import { BrowserPane } from "./BrowserPane.js";

/**
 * The refusal banner the pane raises — a plain group, since the frame's announcer
 * owns the announcement — read by that role and scoped by the banner's own class,
 * so an unrelated group in the pane can never satisfy the query. Awaited through
 * `waitFor` because the port settles a refusal asynchronously and a bare role
 * query would answer before it lands.
 */
function queryRefusalBanner(): HTMLElement | null {
  return (
    screen
      .queryAllByRole("group")
      .find((element) => element.classList.contains("meridian-refusal--banner")) ?? null
  );
}

async function findRefusalBanner(): Promise<HTMLElement> {
  return waitFor(() => {
    const banner = queryRefusalBanner();
    expect(banner).not.toBeNull();
    return banner as HTMLElement;
  });
}

function paneContext(bridge: ConsoleBridge = createFixtureBridge({ scenario: BROWSER_SCENARIO })): {
  readonly context: ConsolePaneContext;
  readonly bridge: ConsoleBridge;
} {
  return {
    bridge,
    context: {
      kind: "browser",
      entity: undefined,
      paneId: "pane-browser-1",
      bridge,
      frameStore: new FrameStore(),
      sessionStore: undefined,
      uiStateStore: UiStateStore.opening(),
      draftStore: new DraftStore(),
      focusHue: undefined,
    },
  };
}

/**
 * Mount the pane and let its navigation subscription settle.
 *
 * The `await act` is not ceremony: the subscription resolves in a microtask after the
 * render, and a test that asserted before it landed would be asserting against a pane
 * one state transition younger than the one an operator ever sees.
 */
async function renderBrowserPane(bridge?: ConsoleBridge): Promise<{
  readonly region: HTMLElement;
  readonly bridge: ConsoleBridge;
}> {
  const built = paneContext(bridge);
  await act(async () => {
    render(<BrowserPane {...built.context} />);
  });
  return { region: screen.getByRole("region", { name: "Browser" }), bridge: built.bridge };
}

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
});

describe("browser pane address field", () => {
  it("refuses a filesystem destination without dispatching a navigation", async () => {
    const bridge = createFixtureBridge({ scenario: BROWSER_SCENARIO });
    const navigate = vi.spyOn(bridge.growth, "browserNavigate");
    await renderBrowserPane(bridge);
    const field = screen.getByLabelText("Destination");
    fireEvent.change(field, { target: { value: "/etc/hosts" } });
    fireEvent.submit(field.closest("form") as HTMLFormElement);
    expect(navigate).not.toHaveBeenCalled();
    expect((await findRefusalBanner()).textContent).toContain("takes web destinations only");
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
