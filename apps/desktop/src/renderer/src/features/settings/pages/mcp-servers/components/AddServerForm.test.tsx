// `Add a server` over a scenario's bridge, its send reaching the service through `callDaemon`: a
// value typed into the form is sent once and then held nowhere, neither in the form nor in the
// window's diagnostic capture, whether the service takes the server or refuses it.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MCP_SERVER_CONFIG_INVALID_CODE } from "@ai-sidekicks/contracts/mcp/governance";
import type {
  McpServerBindingId,
  McpServerMutationResponse,
} from "@ai-sidekicks/contracts/mcp/server";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
import { FixtureBridgeProvider } from "#test/helpers/app/frame-fixtures.js";
import { withDaemonCall } from "#test/helpers/fixture/bridge.js";
import { settleScheduledRead } from "#test/helpers/scheduled-read.js";
import { collectSentDiagnostics } from "#test/helpers/sent-diagnostics.js";
import { settle } from "#test/helpers/settle.js";
import { McpServersMount } from "../McpServersMount.js";

afterEach(() => {
  cleanup();
});

/** The value the person types, which must leave in the request and stay nowhere after it. */
const TYPED_VALUE = "typed-value-held-only-to-send";

/** The service's answer to a server it took. */
const SERVER_TAKEN: McpServerMutationResponse = {
  server: {
    provider: "claude" as ProviderId,
    scope: "user",
    serverName: "notes",
    serverBindingId: "binding-notes" as McpServerBindingId,
    config: { transport: "stdio", command: "notes-mcp", envVarNames: ["NOTES_TOKEN"] },
    status: "unknown",
    enabled: true,
    tools: [],
  },
  applied: "userConfigWrite",
};

/** The service's refusal of the declaration, naming the field and never its value. */
const DECLARATION_REFUSED = {
  code: -31000,
  message: "the MCP server configuration is invalid: env.NOTES_TOKEN is not taken",
  data: {
    type: MCP_SERVER_CONFIG_INVALID_CODE,
    category: "invalidArgument",
    fields: { issues: [{ path: ["config", "env", "NOTES_TOKEN"], message: "not taken" }] },
  },
};

describe("AddServerForm", () => {
  it.each(["taken", "refused"] as const)(
    "sends a typed value once and holds it nowhere after the send is %s",
    async (answer) => {
      const fixture = createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO });
      const under = withDaemonCall(fixture.bridge, async (call, passThrough) => {
        if (call.method !== "mcp.server.upsert") {
          return await passThrough();
        }
        if (answer === "refused") {
          throw DECLARATION_REFUSED;
        }
        return await Promise.resolve(SERVER_TAKEN);
      });
      const diagnostics = await collectSentDiagnostics();
      const { container } = render(
        <FixtureBridgeProvider fixture={{ ...fixture, bridge: under.bridge }}>
          <LiveAnnouncerProvider>
            <McpServersMount />
          </LiveAnnouncerProvider>
        </FixtureBridgeProvider>,
      );
      await settleScheduledRead(fixture.scenarioEngine.clock);

      fireEvent.click(screen.getByRole("button", { name: "Add a server" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
        target: { value: "notes" },
      });
      fireEvent.change(screen.getByRole("textbox", { name: "Command" }), {
        target: { value: "notes-mcp" },
      });
      const variables = within(screen.getByRole("group", { name: "Environment variables" }));
      fireEvent.change(variables.getByRole("textbox", { name: "Environment variable name" }), {
        target: { value: "NOTES_TOKEN" },
      });
      fireEvent.change(variables.getByLabelText("Environment variable value"), {
        target: { value: TYPED_VALUE },
      });
      fireEvent.click(variables.getByRole("button", { name: "Add" }));
      fireEvent.click(screen.getByRole("button", { name: "Add the server" }));
      await settle();

      const sent = under.calls.filter((call) => call.method === "mcp.server.upsert");
      expect(sent).toHaveLength(1);
      expect(sent[0]?.params).toMatchObject({
        scope: "user",
        serverName: "notes",
        config: { transport: "stdio", command: "notes-mcp", env: { NOTES_TOKEN: TYPED_VALUE } },
      });
      expect(container.textContent).toContain(
        answer === "taken"
          ? "The server was sent to the background service."
          : "the MCP server configuration is invalid",
      );
      const fieldValues = [...container.querySelectorAll("input, textarea")].map(
        (field) => (field as HTMLInputElement | HTMLTextAreaElement).value,
      );
      expect(fieldValues.some((value) => value.includes(TYPED_VALUE))).toBe(false);
      expect(container.innerHTML).not.toContain(TYPED_VALUE);
      // The refusal reached the capture by its method and paths, and no record carries the value.
      const records = await diagnostics.records();
      diagnostics.stop();
      if (answer === "refused") {
        expect(records.some((record) => record.detail.includes("mcp.server.upsert"))).toBe(true);
      }
      expect(JSON.stringify(records)).not.toContain(TYPED_VALUE);
    },
  );
});
