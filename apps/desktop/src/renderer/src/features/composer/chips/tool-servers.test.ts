// The tool-servers chip counts only the servers switched on, reads `MCP` with none, and groups its
// list by state: working first (starting and unknown among them), then needing a sign-in, failed
// last.

import { describe, expect, it } from "vitest";

import type { SessionMcpServer } from "@ai-sidekicks/contracts/session/controls/methods";

import { readToolServersChip } from "./tool-servers.js";

function server(
  serverName: string,
  status: SessionMcpServer["status"],
  enabled: boolean,
): SessionMcpServer {
  return { serverName, status, enabled, pendingUntilNextTurn: false };
}

describe("the composer's tool-servers chip", () => {
  it("counts the servers switched on and groups the rest by state", () => {
    // Mutation: counting every server instead of the switched-on ones reads `MCP 5`.
    const chip = readToolServersChip([
      server("linear", "failed", true),
      server("github", "connected", true),
      server("figma", "needsAuth", false),
      server("sentry", "starting", true),
      server("notion", "unknown", false),
    ]);
    expect(chip.label).toBe("MCP 3");
    expect(chip.working.map((each) => each.serverName)).toStrictEqual([
      "github",
      "sentry",
      "notion",
    ]);
    expect(chip.notWorking.map((each) => each.serverName)).toStrictEqual(["figma", "linear"]);
  });

  it("reads `MCP` with no server switched on", () => {
    expect(readToolServersChip([]).label).toBe("MCP");
    expect(readToolServersChip([server("github", "connected", false)]).label).toBe("MCP");
  });
});
