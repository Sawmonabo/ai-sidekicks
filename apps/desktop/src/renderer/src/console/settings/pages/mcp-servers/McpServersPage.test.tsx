// The servers page declares its non-disclosure and its one deliberate exception,
// derives no eligibility, and mounts a seat rather than a body.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { McpServersPage, registerMcpServersPage } from "./McpServersPage.js";
import { MCP_SERVERS_PAGE, MCP_SERVERS_PAGE_SLOT } from "./mcp-servers-slot.js";
import { SettingsPageRegistry, type SettingsPageContext } from "../../settings-page-registry.js";
import { UNREPORTED_SHELL_STATE } from "../../../store/index.js";

const CONTEXT = {
  bridge: undefined as never,
  openSection: () => undefined,
  retainedSessionId: undefined,
  retainedSessionStore: undefined,
  shellState: UNREPORTED_SHELL_STATE,
} satisfies SettingsPageContext;

function renderedText(): string {
  const { container } = render(<McpServersPage context={CONTEXT} />);
  return container.textContent ?? "";
}

describe("the servers page — what it may never show", () => {
  it("states each prohibition separately rather than as one paragraph", () => {
    const text = renderedText();
    for (const forbidden of ["configuration value", "environment-variable value", "header value"]) {
      expect(text).toContain(forbidden);
    }
    expect(text).toContain("redacted view the daemon serves");
  });

  it("renders no value-bearing input of its own", () => {
    // The configuration form is the owning plan's, and its credential-bearing
    // fields are write-only. A field here would be a second place a value could be
    // typed into and a first place one could be read back out of.
    const { container } = render(<McpServersPage context={CONTEXT} />);
    expect(container.querySelectorAll("input, select, textarea")).toHaveLength(0);
  });

  it("negative control: the page does render prose that could have carried one", () => {
    // Without this, the case above would pass over a page that rendered nothing.
    expect(renderedText().length).toBeGreaterThan(400);
  });
});

describe("the servers page — who decides", () => {
  it("says the daemon refuses rather than that the page withholds", () => {
    const text = renderedText();
    expect(text).toContain("Every control offered");
    expect(text).toContain("Nothing on this page decides");
  });

  it("negative control: it does not describe a control as unavailable", () => {
    // This page is the console's one deliberate departure from absent-not-disabled:
    // offering a control and rendering the refusal is the rule here, so copy that
    // spoke of a control being unavailable would be the wrong page's copy.
    expect(renderedText()).not.toMatch(/\bunavailable\b|\bnot permitted\b/u);
  });
});

describe("the servers page — the seat it mounts", () => {
  it("states the body's absence rather than drawing an empty inventory", () => {
    expect(renderedText()).toContain(MCP_SERVERS_PAGE.reservationTitle);
  });

  it("puts none of the seat's contract on screen", () => {
    const text = renderedText();
    expect(text).not.toContain(MCP_SERVERS_PAGE_SLOT.contract.owningTask);
    expect(text).not.toContain(MCP_SERVERS_PAGE_SLOT.contract.mountObligation);
    expect(text).not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP|I)-\d/u);
  });

  it("answers all three of the questions a seat exists to answer", () => {
    const { contract } = MCP_SERVERS_PAGE_SLOT;
    expect(contract.owningTask.length).toBeGreaterThan(0);
    expect(contract.mountObligation.length).toBeGreaterThan(0);
    expect(contract.deleteShellIn.length).toBeGreaterThan(0);
    expect(MCP_SERVERS_PAGE_SLOT.body).toBeUndefined();
  });

  it("claims the servers section with a search vocabulary", () => {
    const registry = new SettingsPageRegistry();
    registerMcpServersPage(registry);
    const descriptor = registry.descriptorFor("mcp-servers");
    expect(descriptor?.label).toBe("MCP servers");
    expect(descriptor?.keywords).toContain("model context protocol");
  });
});
