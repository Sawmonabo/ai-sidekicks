// The MCP servers page as a fixture launch mounts it: the fixture body registered into the page,
// its inventory listed, a picked server's changes reaching the scenario's scripted replies
// through `callDaemon`, and the re-read after a change answering with what was written: a
// switched-off binding stays off, and a tool's facet cleared back to the server's own leaves its
// other set.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { FixtureBridgeProvider } from "#test/helpers/app/frame-fixtures.js";
import { settleScheduledRead } from "#test/helpers/scheduled-read.js";
import { settle } from "#test/helpers/settle.js";
import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
import { McpServersPage } from "../McpServersPage.js";
import { registerMcpFixtureBody } from "./register-body.js";

afterEach(() => {
  cleanup();
});

describe("McpFixtureMount", () => {
  it("draws the scenario's scripted inventory and sends an enablement change to it", async () => {
    registerMcpFixtureBody();
    const fixture = createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO });
    const { container } = render(
      <FixtureBridgeProvider fixture={fixture}>
        <LiveAnnouncerProvider>
          <McpServersPage />
        </LiveAnnouncerProvider>
      </FixtureBridgeProvider>,
    );
    await settleScheduledRead(fixture.scenarioEngine.clock);

    const serverNames = [...container.querySelectorAll(".meridian-mcp__entry-identity")].map(
      (identity) => identity.firstElementChild?.textContent,
    );
    expect(serverNames).toStrictEqual(["filesystem", "issue-tracker", "scratchpad", "scratchpad"]);

    const [enableControl] = runSwitchesOf(container, 0);
    if (enableControl === undefined) {
      throw new Error("the scripted inventory rendered no enablement control to press");
    }
    fireEvent.click(enableControl);
    // The scripted enablement change answers after its latency.
    await settle(() => {
      fixture.scenarioEngine.advance(200);
    });
    expect(container.textContent).toContain("Saved. The next session uses it.");
  });

  it("keeps a switched-off binding switched off after the inventory is read again", async () => {
    registerMcpFixtureBody();
    const fixture = createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO });
    const { container } = render(
      <FixtureBridgeProvider fixture={fixture}>
        <LiveAnnouncerProvider>
          <McpServersPage />
        </LiveAnnouncerProvider>
      </FixtureBridgeProvider>,
    );
    await settleScheduledRead(fixture.scenarioEngine.clock);
    const enablementControls = (): readonly (string | null)[] =>
      // Read as each server is picked, since picking the next one redraws the pane.
      [0, 1, 2, 3].flatMap((nth) =>
        runSwitchesOf(container, nth).map((control) => control.getAttribute("aria-checked")),
      );
    // The binding whose store could not be read sent no enablement, so it has no switch.
    expect(enablementControls()).toStrictEqual(["true", "true", "true"]);

    const [disableControl] = runSwitchesOf(container, 0);
    if (disableControl === undefined) {
      throw new Error("the scripted inventory rendered no control to switch a binding off");
    }
    fireEvent.click(disableControl);
    // The write answers after its latency, and the body reads the inventory again.
    await settle(() => {
      fixture.scenarioEngine.advance(200);
    });
    await settleScheduledRead(fixture.scenarioEngine.clock);

    expect(enablementControls()).toStrictEqual(["false", "true", "true"]);
  });

  it("clears one facet of a tool back to the server's own and leaves its other facet set", async () => {
    registerMcpFixtureBody();
    const fixture = createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO });
    const { container } = render(
      <FixtureBridgeProvider fixture={fixture}>
        <LiveAnnouncerProvider>
          <McpServersPage />
        </LiveAnnouncerProvider>
      </FixtureBridgeProvider>,
    );
    await settleScheduledRead(fixture.scenarioEngine.clock);
    selectEntry(container, 0);
    const writeFile = (): Element => {
      const row = [...container.querySelectorAll(".meridian-mcp__tool")].find((tool) =>
        (tool.textContent ?? "").startsWith("write_file"),
      );
      if (row === undefined) {
        throw new Error("the scripted inventory drew no write_file tool");
      }
      return row;
    };
    const readings = (): readonly (readonly (string | null | undefined)[])[] =>
      [...writeFile().querySelectorAll(".meridian-mcp__tool-setting")]
        .slice(1)
        .map((setting) => [
          setting.querySelector("select")?.selectedOptions[0]?.textContent,
          setting.lastElementChild?.textContent,
        ]);
    expect(readings()).toStrictEqual([
      ["Ask every time", "Set here"],
      ["Can be undone", "Set here"],
    ]);

    const [approval] = writeFile().querySelectorAll("select");
    if (approval === undefined) {
      throw new Error("write_file drew no approval choice to make");
    }
    // The server's own approval mode for write_file.
    fireEvent.change(approval, { target: { value: "auto" } });
    await settle(() => {
      fixture.scenarioEngine.advance(200);
    });
    await settleScheduledRead(fixture.scenarioEngine.clock);

    expect(readings()).toStrictEqual([
      ["Run without asking", "The server's own"],
      ["Can be undone", "Set here"],
    ]);
  });
});

/** Picks the `nth` server in the list. */
function selectEntry(container: HTMLElement, nth: number): void {
  const entry = container.querySelectorAll(".meridian-mcp__entry")[nth];
  if (entry === undefined) {
    throw new Error(`the scripted inventory drew no server at position ${String(nth)}`);
  }
  fireEvent.click(entry);
}

/** The `nth` server's `On for runs` switch, once it is picked; none where it has no reading. */
function runSwitchesOf(container: HTMLElement, nth: number): readonly HTMLElement[] {
  selectEntry(container, nth);
  return [...container.querySelectorAll(".meridian-mcp__detail .meridian-switch__label")]
    .filter((label) => label.textContent === "On for runs")
    .map((label) => label.querySelector('[role="switch"]'))
    .filter((control): control is HTMLElement => control instanceof HTMLElement);
}
