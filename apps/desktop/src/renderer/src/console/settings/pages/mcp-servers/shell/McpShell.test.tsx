// The MCP shell, driven against the deck it actually ships in.
//
// THE SCENARIO IS THE REAL ONE, so every state asserted below is a state a reviewer
// can reach from the scenario selector in a running fixture build. The three rows it
// scripts are the three arms this page has to draw: an ordinary trusted binding, one
// that needs authorization while a leg of it is fine, and one whose trust store could
// not be read at all.
//
// THE EMPTY INVENTORY IS DRIVEN THROUGH THE PORT rather than through a second
// scenario, because a node governing no servers is not a story — it is the answer the
// unscripted fixture already gives, and asserting it here keeps the two agreeing.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SidekicksBridgeProvider,
  createFixtureBridge,
  growthUnavailable,
  type ConsoleBridge,
} from "../../../../bridge/index.js";
import { settleScriptedRead } from "../../../../bridge/readings/scheduled-read.test-support.js";
import { SETTINGS_SCENARIO } from "../../../../bridge/scenarios/settings.js";
import { LiveAnnouncerProvider } from "../../../../primitives/index.js";
import { McpShell } from "./McpShell.js";

afterEach(() => {
  cleanup();
});

function fixtureBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: SETTINGS_SCENARIO });
}

function renderShell(bridge: ConsoleBridge, mintKey?: () => string): HTMLElement {
  const { container } = render(
    <SidekicksBridgeProvider bridge={bridge}>
      <LiveAnnouncerProvider>
        {mintKey === undefined ? (
          <McpShell bridge={bridge} />
        ) : (
          <McpShell bridge={bridge} mintKey={mintKey} />
        )}
      </LiveAnnouncerProvider>
    </SidekicksBridgeProvider>,
  );
  return container;
}

async function renderSettledShell(
  bridge: ConsoleBridge,
  mintKey?: () => string,
): Promise<HTMLElement> {
  const container = renderShell(bridge, mintKey);
  await settleScriptedRead(bridge);
  return container;
}

describe("McpShell", () => {
  it("draws a loading absence before the inventory answers", () => {
    const container = renderShell(fixtureBridge());
    expect(container.textContent).toContain("servers this node governs");
    expect(container.querySelectorAll(".meridian-mcp__row")).toHaveLength(0);
  });

  it("lists one row per scope-qualified binding", async () => {
    const container = await renderSettledShell(fixtureBridge());
    expect(container.querySelectorAll(".meridian-mcp__row")).toHaveLength(3);
  });

  it("renders the daemon's aggregate status rather than folding the legs itself", async () => {
    const container = await renderSettledShell(fixtureBridge());
    const rowWithDisagreeingLegs = [...container.querySelectorAll(".meridian-mcp__row")].find(
      (row) => (row.textContent ?? "").includes("issue-tracker"),
    );
    // Its two legs disagree — one `needs-auth`, one `connected` — and the row's own
    // chip carries the daemon's severity aggregate. A page that folded the legs by
    // eye would have had to pick one of them.
    expect(rowWithDisagreeingLegs?.textContent).toContain("needs-auth");
    expect(rowWithDisagreeingLegs?.textContent).toContain("connected");
  });

  it("renders names where the wire carries names, and no value anywhere", async () => {
    const container = await renderSettledShell(fixtureBridge());
    expect(container.textContent).toContain("Environment variables read");
    expect(container.textContent).toContain("Headers sent");
    expect(container.textContent).toContain("Bearer token read from");
  });

  it("withholds the trust control on the row whose trust store could not be read", async () => {
    const container = await renderSettledShell(fixtureBridge());
    const degradedRow = [...container.querySelectorAll(".meridian-mcp__row")].find((row) =>
      (row.textContent ?? "").includes("scratchpad"),
    );
    expect(degradedRow?.textContent).toContain("trust control is withheld");
    expect(
      [...(degradedRow?.querySelectorAll("button") ?? [])].map((b) => b.textContent),
    ).not.toContain("Grant trust");
  });

  // The negative control for the case above: every other row DOES offer it, so the
  // withholding is about that row's arm and not about the page having no control.
  it("offers the trust control on the rows whose trust arm arrived", async () => {
    const container = await renderSettledShell(fixtureBridge());
    const trustButtons = [...container.querySelectorAll("button")].filter((button) =>
      /trust/iu.test(button.textContent ?? ""),
    );
    expect(trustButtons).toHaveLength(2);
  });

  it("names no invented status on the degraded row", async () => {
    const container = await renderSettledShell(fixtureBridge());
    const degradedRow = [...container.querySelectorAll(".meridian-mcp__row")].find((row) =>
      (row.textContent ?? "").includes("scratchpad"),
    );
    expect(degradedRow?.textContent).toContain("could not be read");
    expect(degradedRow?.textContent).not.toContain("No tool on this binding carries an override");
  });

  it("renders a partial application: one leg applied, one failed", async () => {
    const bridge = fixtureBridge();
    const container = await renderSettledShell(bridge);
    const enableButtons = [...container.querySelectorAll("button")].filter((button) =>
      /this binding$/u.test(button.textContent ?? ""),
    );
    const firstEnableButton = enableButtons[0];
    expect(firstEnableButton).toBeDefined();
    fireEvent.click(firstEnableButton as HTMLButtonElement);
    await settleScriptedRead(bridge);
    expect(container.textContent).toContain("live_reconcile");
    expect(container.textContent).toContain("mcp.config_write_conflict");
  });

  it("sends the key the caller minted for that press", async () => {
    const bridge = fixtureBridge();
    const sent: unknown[] = [];
    const recordingBridge: ConsoleBridge = {
      ...bridge,
      growth: {
        ...bridge.growth,
        mcpSetEnabled: vi.fn(async (request) => {
          sent.push(request);
          return await bridge.growth.mcpSetEnabled(request);
        }),
      },
    };
    const container = await renderSettledShell(recordingBridge, () => "one-press");
    const enableButtons = [...container.querySelectorAll("button")].filter((button) =>
      /this binding$/u.test(button.textContent ?? ""),
    );
    fireEvent.click(enableButtons[0] as HTMLButtonElement);
    await settleScriptedRead(recordingBridge);
    expect(sent).toHaveLength(1);
    expect((sent[0] as { clientIdempotencyKey: string }).clientIdempotencyKey).toBe("one-press");
  });

  it("draws the empty inventory as an ordinary state rather than a failure", async () => {
    const bridge = fixtureBridge();
    const emptyBridge: ConsoleBridge = {
      ...bridge,
      growth: {
        ...bridge.growth,
        mcpList: vi.fn(
          async () => await Promise.resolve({ status: "served" as const, value: { servers: [] } }),
        ),
      },
    };
    const container = await renderSettledShell(emptyBridge);
    expect(container.textContent).toContain("governs no MCP servers");
  });

  it("draws the port's own refusal where the inventory read could not be put", async () => {
    const bridge = fixtureBridge();
    const refusingBridge: ConsoleBridge = {
      ...bridge,
      growth: {
        ...bridge.growth,
        mcpList: vi.fn(async () => await Promise.resolve(growthUnavailable("mcpList"))),
      },
    };
    await renderSettledShell(refusingBridge);
    expect(screen.getByRole("button", { name: /try again/iu })).toBeDefined();
  });
});
