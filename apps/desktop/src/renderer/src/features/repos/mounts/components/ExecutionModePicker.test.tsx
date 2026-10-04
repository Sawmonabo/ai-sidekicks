// The mode picker: one row per mode the reply names and none it does not, a restricted mode
// drawn and unpickable, one selection per change, and the group held while the mount
// withholds its controls or a switch is on the wire.

import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts/workspace";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ExecutionModePicker } from "./ExecutionModePicker.js";
import {
  readWorkspaceControlAvailability,
  type WorkspaceControlAvailability,
} from "../mount-health.js";

/** The two availabilities a card hands down, composed through the real predicate. */
const CONTROLS_LIVE: WorkspaceControlAvailability = readWorkspaceControlAvailability(
  { available: true },
  undefined,
);
const CONTROLS_HELD_BY_THE_MOUNT: WorkspaceControlAvailability = readWorkspaceControlAvailability(
  { available: false, unavailableBecause: "This mount is no longer reachable." },
  undefined,
);
const CONTROLS_HELD_BY_A_SWITCH: WorkspaceControlAvailability = readWorkspaceControlAvailability(
  { available: true },
  "provisioned-worktree",
);

const GIT_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["bound-root", "provisioned-worktree"],
  defaultMode: "provisioned-worktree",
};

const RESTRICTED_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["bound-root"],
  defaultMode: "bound-root",
  restrictions: {
    "provisioned-worktree": "no room for another worktree on this machine",
  },
};

function renderPicker(
  capabilities: WorkspaceExecutionModeCapabilitiesReadResponse | undefined,
  overrides: Partial<React.ComponentProps<typeof ExecutionModePicker>> = {},
): ReturnType<typeof render> {
  return render(
    <ExecutionModePicker
      workspaceId="workspace-1"
      currentMode="bound-root"
      capabilities={capabilities}
      pendingMode={undefined}
      availability={CONTROLS_LIVE}
      refusal={undefined}
      onSelect={() => undefined}
      {...overrides}
    />,
  );
}

describe("ExecutionModePicker — the rows come from the reply", () => {
  it("renders one enabled row per available mode, in the daemon's order", () => {
    const { container } = renderPicker(GIT_CAPABILITIES);
    const radios = container.querySelectorAll<HTMLInputElement>("input[type=radio]");
    expect([...radios].map((radio) => radio.value)).toStrictEqual([
      "bound-root",
      "provisioned-worktree",
    ]);
    expect([...radios].every((radio) => !radio.disabled)).toBe(true);
  });

  it("negative control: a mode named in neither half of the reply gets no row", () => {
    // A hardcoded mode list would still draw `provisioned-worktree` here, with no reason
    // beside it.
    const { container } = renderPicker({
      availableModes: ["bound-root"],
      defaultMode: "bound-root",
    });
    const radios = container.querySelectorAll<HTMLInputElement>("input[type=radio]");
    expect([...radios].map((radio) => radio.value)).toStrictEqual(["bound-root"]);
  });

  it("renders a disabled row per restricted mode, carrying the daemon's own reason", () => {
    const { container, getAllByText } = renderPicker(RESTRICTED_CAPABILITIES);
    const radios = container.querySelectorAll<HTMLInputElement>("input[type=radio]");
    expect([...radios].map((radio) => radio.value)).toStrictEqual([
      "bound-root",
      "provisioned-worktree",
    ]);
    expect([...radios].filter((radio) => radio.disabled).map((radio) => radio.value)).toStrictEqual(
      ["provisioned-worktree"],
    );
    // Verbatim, once — beside the row it is about.
    expect(getAllByText("no room for another worktree on this machine")).toHaveLength(1);
  });
});

describe("ExecutionModePicker — absences and holds", () => {
  it("sends exactly one selection per change, and never one of its own", () => {
    const onSelect = vi.fn();
    const { container } = renderPicker(GIT_CAPABILITIES, { onSelect });
    expect(onSelect).not.toHaveBeenCalled();
    const worktree = container.querySelector<HTMLInputElement>(
      'input[value="provisioned-worktree"]',
    );
    worktree?.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("provisioned-worktree");
  });

  it("disables the whole group when the mount withholds its bind controls", () => {
    const { container, getByRole } = renderPicker(GIT_CAPABILITIES, {
      availability: CONTROLS_HELD_BY_THE_MOUNT,
    });
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    // A disabled `fieldset` paints nothing that explains itself, so the reason must be text.
    expect(getByRole("status").textContent).toBe("This mount is no longer reachable.");
  });
});

describe("ExecutionModePicker — a switch the daemon has not answered", () => {
  it("holds every row and names the mode it is holding for", () => {
    // Two selects issued before the first settles both run and the last to reach the daemon
    // decides, so the group holds until the answer arrives. The card supplies the availability and
    // `pendingMode` from one derivation, so both are passed.
    const { container, getByRole } = renderPicker(GIT_CAPABILITIES, {
      pendingMode: "provisioned-worktree",
      availability: CONTROLS_HELD_BY_A_SWITCH,
    });

    // The fieldset, not the inputs: an input's own `disabled` never reflects the group's.
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    // Named, not merely grayed: the rows keep showing the mode the workspace is bound as.
    expect(getByRole("status").textContent).toContain("Switching to");
    expect(getByRole("status").textContent).toContain("provisioned-worktree");
  });
});
