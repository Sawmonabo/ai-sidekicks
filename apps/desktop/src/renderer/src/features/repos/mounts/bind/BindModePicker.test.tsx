// The bind form's mode rows over the one derivation both pickers read through. The case that
// matters is a mode named as both available and restricted: two copies of the derivation
// could disagree, one blanking the reason and the other keeping it. The sibling picker's case
// is in `ExecutionModePicker.test.tsx`.

import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { executionModeRows } from "../execution-mode-rows.js";
import { BindModePicker } from "./BindModePicker.js";

/** A reply that names `bound-root` in both halves: malformed, and reachable. */
const AVAILABLE_AND_RESTRICTED: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["bound-root", "provisioned-worktree"],
  defaultMode: "bound-root",
  restrictions: { "bound-root": "This branch is checked out somewhere else." },
};

function renderPicker(
  capabilities: WorkspaceExecutionModeCapabilitiesReadResponse,
): ReturnType<typeof render> {
  return render(
    <BindModePicker
      options={executionModeRows(capabilities)}
      selectedMode={undefined}
      groupName="test-modes"
      onSelect={vi.fn()}
    />,
  );
}

describe("BindModePicker", () => {
  it("shows the mount's reason on a mode it also offers", () => {
    const { getByText, getByDisplayValue } = renderPicker(AVAILABLE_AND_RESTRICTED);
    expect(getByText("This branch is checked out somewhere else.")).toBeTruthy();
    // Still offered: the reply is the authority on what is admitted.
    expect((getByDisplayValue("bound-root") as HTMLInputElement).disabled).toBe(false);
  });

  it("disables an excluded mode and renders the daemon's own words for it", () => {
    const { getByText, getByDisplayValue } = renderPicker({
      availableModes: ["bound-root"],
      defaultMode: "bound-root",
      restrictions: { "provisioned-worktree": "This workspace runs only in its own root." },
    });
    expect((getByDisplayValue("provisioned-worktree") as HTMLInputElement).disabled).toBe(true);
    expect(getByText("This workspace runs only in its own root.")).toBeTruthy();
  });

  it("negative control: an unrestricted reply renders no reason anywhere", () => {
    const { container, queryByText } = renderPicker({
      availableModes: ["bound-root", "provisioned-worktree"],
      defaultMode: "bound-root",
    });
    expect(queryByText("This branch is checked out somewhere else.")).toBeNull();
    expect(container.querySelectorAll(".meridian-bind__mode-reason")).toHaveLength(0);
  });
});
