// The bind form's mode rows, over the one derivation both pickers now read through.
//
// THE ARM THAT MATTERS is a mode the reply names as both available and restricted.
// Two copies of that derivation existed, and the bind dialog's blanked the reason
// while the mode picker's kept it — so the same malformed reply disclosed the
// restriction on one surface and hid it on the other. This drives the real component
// over the real `executionModeRows`, with the sibling surface's own case in
// `ExecutionModePicker.test.tsx` making the pair.

import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { executionModeRows } from "../mode-row.js";
import { BindModePicker } from "./BindModePicker.js";

/** A reply that names `branch` in both halves. Malformed, and reachable. */
const AVAILABLE_AND_RESTRICTED: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["read-only", "branch"],
  defaultMode: "branch",
  restrictions: { branch: "This branch is checked out somewhere else." },
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
    // And it is still offered: the reply is the authority on what is admitted.
    expect((getByDisplayValue("branch") as HTMLInputElement).disabled).toBe(false);
  });

  it("disables an excluded mode and renders the daemon's own words for it", () => {
    const { getByText, getByDisplayValue } = renderPicker({
      availableModes: ["read-only"],
      defaultMode: "read-only",
      restrictions: { worktree: "This mount is not a git repository." },
    });
    expect((getByDisplayValue("worktree") as HTMLInputElement).disabled).toBe(true);
    expect(getByText("This mount is not a git repository.")).toBeTruthy();
  });

  it("negative control: an unrestricted reply renders no reason anywhere", () => {
    const { container, queryByText } = renderPicker({
      availableModes: ["read-only", "branch"],
      defaultMode: "branch",
    });
    expect(queryByText("This branch is checked out somewhere else.")).toBeNull();
    expect(container.querySelectorAll(".meridian-bind__mode-reason")).toHaveLength(0);
  });
});
