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

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SidekicksBridgeProvider,
  createFixtureBridge,
  growthUnavailable,
  useConsoleBridge,
  type ConsoleBridge,
  type GrowthMcpMutationResult,
  type GrowthOutcome,
} from "../../../../bridge/index.js";
import { settleScriptedRead } from "../../../../bridge/readings/scheduled-read.test-support.js";
import { SETTINGS_SCENARIO } from "../../../../bridge/scenarios/settings.js";
import { crossMacrotaskBoundary } from "../../../../core/macrotask-boundary.test-support.js";
import { LiveAnnouncerProvider } from "../../../../primitives/index.js";
import { McpShell } from "./McpShell.js";

afterEach(() => {
  cleanup();
});

function fixtureBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: SETTINGS_SCENARIO });
}

/**
 * The shell as its seat mounts it: the bridge comes from the provider's resolution.
 *
 * A probe rather than the raw element, because the resolution is what MOVES. The
 * provider replaces it from an effect, one commit after the prop changes, so a tree
 * handing the shell a bridge straight from the outside would put the shell on one
 * transport and its clock on another for that commit — a shape the real seat, which
 * reads `context.bridge`, cannot produce.
 */
function MountedMcpShell(props: { readonly mintKey?: () => string }): React.JSX.Element {
  const bridge = useConsoleBridge();
  return props.mintKey === undefined ? (
    <McpShell bridge={bridge} />
  ) : (
    <McpShell bridge={bridge} mintKey={props.mintKey} />
  );
}

/**
 * The tree, as an element rather than a render.
 *
 * Split out so a case can re-render the SAME mount at a different bridge, which is
 * what `SidekicksBridgeProvider` does on a reconnect or a scenario switch and is the
 * one thing a fresh `render` cannot express.
 */
function shellTree(bridge: ConsoleBridge, mintKey?: () => string): React.JSX.Element {
  return (
    <SidekicksBridgeProvider bridge={bridge}>
      <LiveAnnouncerProvider>
        {mintKey === undefined ? <MountedMcpShell /> : <MountedMcpShell mintKey={mintKey} />}
      </LiveAnnouncerProvider>
    </SidekicksBridgeProvider>
  );
}

function renderShell(bridge: ConsoleBridge, mintKey?: () => string): HTMLElement {
  const { container } = render(shellTree(bridge, mintKey));
  return container;
}

/**
 * The first row's enablement control, which is the press every mutation case makes.
 *
 * Throws rather than asserting, so a case that never reached a settled inventory fails
 * at the line that pressed instead of at an assertion three settles later.
 */
function firstEnableButton(container: HTMLElement): HTMLButtonElement {
  const [button] = [...container.querySelectorAll("button")].filter((candidate) =>
    /this binding$/u.test(candidate.textContent ?? ""),
  );
  if (button === undefined) {
    throw new Error("the settled inventory rendered no enablement control to press");
  }
  return button;
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
    fireEvent.click(firstEnableButton(container));
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
    fireEvent.click(firstEnableButton(container));
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

/**
 * A bridge whose enablement mutation answers only when the case says so.
 *
 * The whole subject is what happens BETWEEN the press and the settlement, so the
 * scenario's own 80 ms reply is too coarse: the case has to replace the bridge while
 * the first one's call is still out, and then release it.
 */
function bridgeHoldingItsMutation(): {
  readonly bridge: ConsoleBridge;
  readonly settleHeldMutation: () => void;
} {
  const base = fixtureBridge();
  const waiting: ((outcome: GrowthOutcome<GrowthMcpMutationResult>) => void)[] = [];
  return {
    bridge: {
      ...base,
      growth: {
        ...base.growth,
        mcpSetEnabled: async () =>
          await new Promise<GrowthOutcome<GrowthMcpMutationResult>>((resolve) => {
            waiting.push(resolve);
          }),
      },
    },
    settleHeldMutation: () => {
      for (const resolve of waiting.splice(0)) {
        resolve(growthUnavailable("mcpSetEnabled"));
      }
    },
  };
}

// The refusal the held mutation answers with, as the operator reads it. Asserted by
// its own sentence rather than by a code, because that is what is on screen.
const HELD_MUTATION_REFUSAL_TEXT = "not registered on this build yet";

describe("McpShell — a bridge replaced under a mounted shell", () => {
  it("shows no outcome from a bridge the mount no longer holds", async () => {
    const superseded = bridgeHoldingItsMutation();
    const { container, rerender } = render(shellTree(superseded.bridge));
    await settleScriptedRead(superseded.bridge);
    fireEvent.click(firstEnableButton(container));
    expect(container.textContent).toContain("Asking the daemon to apply this.");

    const replacementBridge = fixtureBridge();
    rerender(shellTree(replacementBridge));
    await settleScriptedRead(replacementBridge);
    // The replacement answered its own inventory, and the superseded bridge's press
    // is not still reported as in flight against it.
    expect(container.querySelectorAll(".meridian-mcp__row")).toHaveLength(3);
    expect(container.textContent).not.toContain("Asking the daemon to apply this.");

    await act(async () => {
      superseded.settleHeldMutation();
      await crossMacrotaskBoundary();
    });
    expect(container.textContent).not.toContain(HELD_MUTATION_REFUSAL_TEXT);
  });

  // The negative control for the case above: the same held call, the same release, and
  // no replacement — so a clean reading there is about WHOSE settlement it was rather
  // than about this shell never rendering one.
  it("negative control: the same settlement renders while its own bridge still holds", async () => {
    const held = bridgeHoldingItsMutation();
    const container = renderShell(held.bridge);
    await settleScriptedRead(held.bridge);
    fireEvent.click(firstEnableButton(container));

    await act(async () => {
      held.settleHeldMutation();
      await crossMacrotaskBoundary();
    });
    expect(container.textContent).toContain(HELD_MUTATION_REFUSAL_TEXT);
  });
});
