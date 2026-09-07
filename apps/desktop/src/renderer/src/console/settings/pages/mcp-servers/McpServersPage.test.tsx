// The servers page declares its non-disclosure and its one deliberate exception,
// derives no eligibility, and mounts a seat that carries a body under the fixture.
//
// EVERY CLAIM BELOW IS THE FRAME'S, AND IS READ FROM THE FRAME. The seat at the foot
// of this page carries the governance body — the owning plan's when it lands, and the
// fixture shell standing in for it under the fixture define today — so a case that
// read the whole container would be asserting about whichever body was mounted. The
// two claims that ARE about the whole page, that no governance work and no seat
// contract reaches a screen, are the two that read it.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SidekicksBridgeProvider, createFixtureBridge } from "../../../bridge/index.js";
import { SETTINGS_SCENARIO } from "../../../bridge/scenarios/settings.js";
import { LiveAnnouncerProvider } from "../../../primitives/index.js";
import { McpServersPage, registerMcpServersPage } from "./McpServersPage.js";
import { MCP_SERVERS_PAGE_SLOT } from "./mcp-servers-slot.js";
import {
  pageChromeRegions,
  pageChromeText,
  settingsPageContextWith,
} from "../../settings-page-mount.test-support.js";
import { SettingsPageRegistry } from "../../settings-page-registry.js";

/**
 * The page as a window mounts it: inside the bridge provider, over the fixture.
 *
 * A real bridge rather than a cast placeholder, because the seat's body reads one —
 * the console's provider is what resolves the window's clock, and a page mounted
 * outside it throws there rather than rendering. Nothing here settles the body's read:
 * these cases are the frame's, and the body's own suite drives its arms.
 */
function renderPage(): HTMLElement {
  const bridge = createFixtureBridge({ scenario: SETTINGS_SCENARIO });
  const { container } = render(
    <SidekicksBridgeProvider bridge={bridge}>
      <LiveAnnouncerProvider>
        <McpServersPage context={settingsPageContextWith(bridge, SETTINGS_SCENARIO.sessionId)} />
      </LiveAnnouncerProvider>
    </SidekicksBridgeProvider>,
  );
  return container;
}

/** What the page itself says, with the seat's body left out. */
function chromeText(): string {
  return pageChromeText(renderPage());
}

describe("the servers page — what it may never show", () => {
  it("states each prohibition separately rather than as one paragraph", () => {
    const text = chromeText();
    for (const forbidden of ["configuration value", "environment-variable value", "header value"]) {
      expect(text).toContain(forbidden);
    }
    expect(text).toContain("redacted view the daemon serves");
  });

  it("renders no value-bearing input of its own", () => {
    // The configuration form is the owning plan's, and its credential-bearing
    // fields are write-only. A field on the FRAME would be a second place a value
    // could be typed into and a first place one could be read back out of.
    const fields = pageChromeRegions(renderPage()).flatMap((region) => [
      ...region.querySelectorAll("input, select, textarea"),
    ]);
    expect(fields).toHaveLength(0);
  });

  it("negative control: the page does render prose that could have carried one", () => {
    // Without this, the case above would pass over a page that rendered nothing.
    expect(chromeText().length).toBeGreaterThan(400);
  });
});

describe("the servers page — who decides", () => {
  it("says the daemon refuses rather than that the page withholds", () => {
    const text = chromeText();
    expect(text).toContain("Every control offered");
    expect(text).toContain("Nothing on this page decides");
  });

  it("negative control: it does not describe a control as unavailable", () => {
    // This page is the console's one deliberate departure from absent-not-disabled:
    // offering a control and rendering the refusal is the rule here, so copy that
    // spoke of a control being unavailable would be the wrong page's copy.
    expect(chromeText()).not.toMatch(/\bunavailable\b|\bnot permitted\b/u);
  });
});

describe("the servers page — the seat it mounts", () => {
  it("draws the body the seat carries rather than the reservation", () => {
    // The reservation arm is `renderOwnerSlotPage`'s and is covered where that
    // function is: pinning it to whichever seat happens to be empty this week made a
    // case fail the moment a body arrived, which is a stale test rather than a real
    // regression. What is asserted here is the branch this seat is on — a body stands,
    // so the reservation copy is absent and the inventory's own first frame is drawn.
    const text = renderPage().textContent ?? "";
    expect(text).toContain("servers this node governs");
    expect(text).not.toContain("has not been built here yet");
  });

  it("puts none of the seat's contract on screen", () => {
    const text = renderPage().textContent ?? "";
    expect(text).not.toContain(MCP_SERVERS_PAGE_SLOT.contract.owningTask);
    expect(text).not.toContain(MCP_SERVERS_PAGE_SLOT.contract.mountObligation);
    expect(text).not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP|I)-\d/u);
  });

  it("answers all three of the questions a seat exists to answer", () => {
    const { contract } = MCP_SERVERS_PAGE_SLOT;
    // The owner is named by SUBJECT, on the `workflows/owner-slots.ts` precedent: these
    // are runtime strings in a shipped module and this repository keeps governance
    // identifiers in comments, so a length check would pass over the very phrasing this
    // asserts. Read as a positive claim rather than only as the absence below it.
    expect(contract.owningTask).toContain("MCP server configuration and governance plan");
    expect(contract.mountObligation.length).toBeGreaterThan(0);
    // The one that names its own retirement, and it names the directory rather than a
    // date: the body's arrival is what deletes the stand-in.
    expect(contract.deleteShellIn).toContain("mcp-servers/shell/");
  });

  it("carries the stand-in body under the fixture define and nothing without it", () => {
    // This tier compiles `__SIDEKICKS_CONSOLE_FIXTURES__` as `true`, so the seat here
    // holds the shell; a release renderer folds the same expression to `undefined` and
    // the subtree leaves the bundle. Stated as the define's own consequence rather
    // than as a bare `toBeDefined`, so the claim survives being read in either tier.
    expect(MCP_SERVERS_PAGE_SLOT.body !== undefined).toBe(__SIDEKICKS_CONSOLE_FIXTURES__);
  });

  it("claims the servers section with a search vocabulary", () => {
    const registry = new SettingsPageRegistry();
    registerMcpServersPage(registry);
    const descriptor = registry.descriptorFor("mcp-servers");
    expect(descriptor?.label).toBe("MCP servers");
    expect(descriptor?.keywords).toContain("model context protocol");
  });
});
