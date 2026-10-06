// The per-tool rows: each value in force in the page's words, each saying whether it is the
// server's own or set here, exactly as the daemon resolved it.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { IDLE_MCP_MUTATION } from "../mcp-mutation.js";
import { ToolSettingList } from "./ToolSettingList.js";

afterEach(() => {
  cleanup();
});

describe("ToolSettingList", () => {
  it("draws each tool's values in the page's words, each with where it came from", () => {
    const { container } = render(
      <ToolSettingList
        tools={[
          {
            toolName: "read_file",
            enabled: { value: true, source: "server" },
            approvalMode: { value: "auto", source: "server" },
            idempotencyClass: { value: "idempotent", source: "override" },
          },
          {
            toolName: "run_query",
            enabled: { value: false, source: "override" },
            approvalMode: { value: "prompt", source: "override" },
            idempotencyClass: { value: "compensable", source: "server" },
          },
          {
            toolName: "write_file",
            enabled: { value: true, source: "server" },
            approvalMode: { value: "writes", source: "server" },
            idempotencyClass: { value: "manual_reconcile_only", source: "server" },
          },
          {
            toolName: "drop_table",
            enabled: { value: true, source: "server" },
            approvalMode: { value: "approve", source: "override" },
            idempotencyClass: { value: "manual_reconcile_only", source: "server" },
          },
        ]}
        outcomeFor={() => IDLE_MCP_MUTATION}
        onSetToolEnabled={() => undefined}
        sessionDirectory={undefined}
      />,
    );
    const rows = [...container.querySelectorAll(".meridian-mcp__tool")].map((row) => ({
      isOn: row.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
      settings: [...row.querySelectorAll(".meridian-mcp__tool-setting")].map((setting) =>
        [...setting.children].map((part) => part.textContent),
      ),
    }));
    expect(rows).toStrictEqual([
      {
        isOn: "true",
        settings: [
          ["On", "The server's own"],
          ["Ask before running", "Run without asking", "The server's own"],
          ["If a call is interrupted", "Safe to run again", "Set here"],
        ],
      },
      {
        isOn: "false",
        settings: [
          ["On", "Set here"],
          ["Ask before running", "Ask every time", "Set here"],
          ["If a call is interrupted", "Can be undone", "The server's own"],
        ],
      },
      {
        isOn: "true",
        settings: [
          ["On", "The server's own"],
          ["Ask before running", "Ask before it writes", "The server's own"],
          ["If a call is interrupted", "Leave it to a person", "The server's own"],
        ],
      },
      {
        isOn: "true",
        settings: [
          ["On", "The server's own"],
          ["Ask before running", "Ask for approval", "Set here"],
          ["If a call is interrupted", "Leave it to a person", "The server's own"],
        ],
      },
    ]);
  });
});
