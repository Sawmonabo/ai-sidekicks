// The tool overrides, drawn in the words the page's per-tool row uses for each pinned facet.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ToolOverrideList } from "./ToolOverrideList.js";

afterEach(() => {
  cleanup();
});

describe("ToolOverrideList", () => {
  it("draws each approval mode and idempotency class in the page's words", () => {
    const { container } = render(
      <ToolOverrideList
        overrides={[
          { toolName: "read_file", approvalMode: "auto", idempotencyClass: "idempotent" },
          { toolName: "run_query", approvalMode: "prompt", idempotencyClass: "compensable" },
          { toolName: "write_file", approvalMode: "writes" },
          { toolName: "drop_table", approvalMode: "approve" },
        ]}
      />,
    );
    const chipLabels = [...container.querySelectorAll(".meridian-mcp__override")].map((row) =>
      [...row.querySelectorAll(".meridian-chip__label")].map((label) => label.textContent),
    );
    expect(chipLabels).toStrictEqual([
      ["Run without asking", "Safe to run again"],
      ["Ask every time", "Can be undone"],
      ["Ask before it writes"],
      ["Ask for approval"],
    ]);
  });
});
