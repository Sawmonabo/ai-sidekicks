// The per-tool rows: each value in force in the page's words, each saying whether it is the
// server's own or set here, exactly as the daemon resolved it, and each control sending a set for
// any other value and a clear of that facet alone for the server's own.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpToolReading } from "@ai-sidekicks/contracts/mcp/server";
import { ManualClock } from "#renderer/lib/clock.js";
import { ServedProviderSections } from "#renderer/store/providers/ServedProviderSections.test-support.js";
import { IDLE_MCP_MUTATION } from "../mutation.js";
import { ToolSettingList } from "./ToolSettingList.js";

afterEach(() => {
  cleanup();
});

const TOOLS: readonly McpToolReading[] = [
  {
    toolName: "read_file",
    enabled: { value: true, source: "server" },
    approvalMode: { value: "auto", source: "server" },
    idempotencyClass: {
      value: "idempotent",
      source: "override",
      serverValue: "manualReconcileOnly",
    },
  },
  {
    toolName: "run_query",
    enabled: { value: false, source: "override", serverValue: true },
    approvalMode: { value: "prompt", source: "override", serverValue: "writes" },
    idempotencyClass: { value: "manualReconcileOnly", source: "server" },
  },
  {
    toolName: "drop_table",
    enabled: { value: true, source: "server" },
    approvalMode: { value: "approve", source: "override", serverValue: "prompt" },
    idempotencyClass: {
      value: "compensable",
      source: "override",
      serverValue: "manualReconcileOnly",
    },
  },
];

function renderTools(onChangeTool: Parameters<typeof ToolSettingList>[0]["onChangeTool"]): {
  readonly container: HTMLElement;
} {
  return render(
    <ToolSettingList
      tools={TOOLS}
      outcomeFor={() => IDLE_MCP_MUTATION}
      onChangeTool={onChangeTool}
      sessionDirectory={{ status: "reading" }}
      clock={new ManualClock(0)}
    />,
    { wrapper: ServedProviderSections },
  );
}

function toolRow(container: HTMLElement, toolName: string): Element {
  const row = [...container.querySelectorAll(".meridian-mcp__tool")].find((candidate) =>
    (candidate.textContent ?? "").startsWith(toolName),
  );
  if (row === undefined) {
    throw new Error(`no row was drawn for ${toolName}`);
  }
  return row;
}

describe("ToolSettingList", () => {
  it("draws each tool's values in the page's words, each with where it came from", () => {
    const { container } = renderTools(() => undefined);
    const rows = [...container.querySelectorAll(".meridian-mcp__tool")].map((row) => ({
      isOn: row.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
      chosen: [...row.querySelectorAll("select")].map(
        (select) => select.selectedOptions[0]?.textContent,
      ),
      sources: [...row.querySelectorAll(".meridian-mcp__tool-setting")].map(
        (setting) => setting.lastElementChild?.textContent,
      ),
    }));
    expect(rows).toStrictEqual([
      {
        isOn: "true",
        chosen: ["Decided from the tool's own description", "Safe to run again"],
        sources: ["The server's own", "The server's own", "Set here"],
      },
      {
        isOn: "false",
        chosen: ["Always asks", "Leave it to a person"],
        sources: ["Set here", "Set here", "The server's own"],
      },
      {
        isOn: "true",
        chosen: ["Pre-approved, never asks", "Can be undone"],
        sources: ["The server's own", "Set here", "Set here"],
      },
    ]);
    const options = [...toolRow(container, "read_file").querySelectorAll("select")].map((select) =>
      [...select.options].map((option) => option.textContent),
    );
    expect(options).toStrictEqual([
      [
        "Decided from the tool's own description",
        "Always asks",
        "Asks before a tool that writes",
        "Pre-approved, never asks",
      ],
      ["Safe to run again", "Can be undone", "Leave it to a person"],
    ]);
  });

  it("clears a facet chosen back to the server's own value, and sets any other value", () => {
    const onChangeTool = vi.fn();
    const { container } = renderTools(onChangeTool);
    const [approval, interrupted] = toolRow(container, "drop_table").querySelectorAll("select");
    if (approval === undefined || interrupted === undefined) {
      throw new Error("drop_table drew no choice to make");
    }
    fireEvent.change(approval, { target: { value: "prompt" } });
    fireEvent.change(approval, { target: { value: "auto" } });
    fireEvent.change(interrupted, { target: { value: "manualReconcileOnly" } });
    fireEvent.change(interrupted, { target: { value: "idempotent" } });
    const runQuerySwitch = toolRow(container, "run_query").querySelector('[role="switch"]');
    if (!(runQuerySwitch instanceof HTMLElement)) {
      throw new Error("run_query drew no switch to press");
    }
    fireEvent.click(runQuerySwitch);
    expect(onChangeTool.mock.calls.slice(0, 4)).toStrictEqual([
      ["drop_table", "approvalMode", { kind: "clear" }],
      ["drop_table", "approvalMode", { kind: "set", override: { approvalMode: "auto" } }],
      ["drop_table", "idempotencyClass", { kind: "clear" }],
      [
        "drop_table",
        "idempotencyClass",
        { kind: "set", override: { idempotencyClass: "idempotent" } },
      ],
    ]);
    expect(onChangeTool).toHaveBeenLastCalledWith("run_query", "enabled", { kind: "clear" });
  });
});
