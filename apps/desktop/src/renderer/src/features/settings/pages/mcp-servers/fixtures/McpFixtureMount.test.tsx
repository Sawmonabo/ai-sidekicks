// The MCP servers page as a fixture launch mounts it: the fixture body registered into the page,
// its inventory read and its enablement change reaching the scenario's scripted replies through
// `callDaemon`.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import { settleScheduledRead } from "@test/helpers/scheduled-read.js";
import { settle } from "@test/helpers/settle.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../../../../fixtures/scenarios/concurrent-streaming.js";
import { McpServersPage } from "../McpServersPage.js";
import { registerMcpFixtureBody } from "./register-mcp-fixture-body.js";

afterEach(() => {
  cleanup();
});

describe("McpFixtureMount", () => {
  it("draws the scenario's scripted inventory and sends an enablement change through it", async () => {
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

    const rowNames = [...container.querySelectorAll(".meridian-mcp__row-identity")].map(
      (identity) => identity.firstElementChild?.textContent,
    );
    expect(rowNames).toStrictEqual(["filesystem", "issue-tracker", "scratchpad"]);

    const [enableControl] = [...container.querySelectorAll("button")].filter((button) =>
      /this binding$/u.test(button.textContent ?? ""),
    );
    if (enableControl === undefined) {
      throw new Error("the scripted inventory rendered no enablement control to press");
    }
    fireEvent.click(enableControl);
    // The scripted enablement change answers after its latency.
    await settle(() => {
      fixture.scenarioEngine.advance(200);
    });
    expect(container.textContent).toContain("next_run");
  });
});
