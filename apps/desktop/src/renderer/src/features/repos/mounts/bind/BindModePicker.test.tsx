// The bind form's mode rows: an excluded mode is drawn disabled with the daemon's own words.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { executionModeRows } from "../execution-mode/execution-mode-rows.js";
import { BindModePicker } from "./BindModePicker.js";

describe("BindModePicker", () => {
  it("disables an excluded mode and renders the daemon's own words for it", () => {
    const { getByText, getByDisplayValue } = render(
      <BindModePicker
        options={executionModeRows({
          availableModes: ["bound-root"],
          defaultMode: "bound-root",
          restrictions: { "provisioned-worktree": "This workspace runs only in its own root." },
        })}
        selectedMode={undefined}
        groupName="test-modes"
        onSelect={vi.fn()}
      />,
    );
    expect((getByDisplayValue("provisioned-worktree") as HTMLInputElement).disabled).toBe(true);
    expect(getByText("This workspace runs only in its own root.")).toBeTruthy();
  });
});
