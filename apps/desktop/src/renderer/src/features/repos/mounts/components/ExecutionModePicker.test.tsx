// The picker renders the reply and never re-derives it: `availableModes` is not computed as
// everything outside `restrictions`, and `defaultMode` is not treated as the current mode.

import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts";
import { render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ExecutionModePicker } from "./ExecutionModePicker.js";
import {
  readWorkspaceControlAvailability,
  type WorkspaceControlAvailability,
} from "../mount-health.js";

/** The two postures a card hands down, composed through the real predicate. */
const CONTROLS_LIVE: WorkspaceControlAvailability = readWorkspaceControlAvailability(
  { offered: true },
  undefined,
);
const CONTROLS_HELD_BY_THE_MOUNT: WorkspaceControlAvailability = readWorkspaceControlAvailability(
  { offered: false, withheldBecause: "This mount is no longer reachable." },
  undefined,
);
const CONTROLS_HELD_BY_A_SWITCH: WorkspaceControlAvailability = readWorkspaceControlAvailability(
  { offered: true },
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
      posture={CONTROLS_LIVE}
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
});

describe("ExecutionModePicker — default is not current", () => {
  it("labels the default row and the bound row separately", () => {
    const { container } = renderPicker(GIT_CAPABILITIES);
    const rows = container.querySelectorAll(".meridian-mode-picker__row");
    const boundRootRow = rows[0];
    const worktreeRow = rows[1];
    expect(boundRootRow).toBeDefined();
    expect(worktreeRow).toBeDefined();
    expect(within(boundRootRow as HTMLElement).getByText("bound now")).toBeDefined();
    expect(
      within(worktreeRow as HTMLElement).getByText("default for the next writable coding run"),
    ).toBeDefined();
  });

  it("negative control: the bound row does not also claim to be the default", () => {
    // `defaultMode` is `provisioned-worktree` while the workspace is bound `bound-root`; one
    // field read for both would put both tags on one row.
    const { container } = renderPicker(GIT_CAPABILITIES);
    const boundRootRow = container.querySelectorAll(".meridian-mode-picker__row")[0];
    expect(
      within(boundRootRow as HTMLElement).queryByText("default for the next writable coding run"),
    ).toBeNull();
  });
});

describe("ExecutionModePicker — absences and holds", () => {
  it("says nobody asked when there is no reply, rather than showing no modes", () => {
    const { container } = renderPicker(undefined);
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(container.querySelectorAll("input[type=radio]")).toHaveLength(0);
  });

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
      posture: CONTROLS_HELD_BY_THE_MOUNT,
    });
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    // A disabled `fieldset` paints nothing that explains itself, so the reason must be text.
    expect(getByRole("status").textContent).toBe("This mount is no longer reachable.");
  });
});

describe("ExecutionModePicker — a switch the daemon has not answered", () => {
  it("holds every row and names the mode it is holding for", () => {
    // Two selects issued before the first settles both run and the last to reach the daemon
    // decides, so the group holds until the answer arrives. The card supplies the posture and
    // `pendingMode` from one derivation, so both are passed.
    const { container, getByRole } = renderPicker(GIT_CAPABILITIES, {
      pendingMode: "provisioned-worktree",
      posture: CONTROLS_HELD_BY_A_SWITCH,
    });

    // The fieldset, not the inputs: an input's own `disabled` never reflects the group's.
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    // Named, not merely grayed: the rows keep showing the mode the workspace is bound as.
    expect(getByRole("status").textContent).toContain("Switching to");
    expect(getByRole("status").textContent).toContain("provisioned-worktree");
  });

  it("announces the mount's own reason and not the switch when both hold the group", () => {
    // A mount can go unreachable while a switch is on the wire; "wait for the daemon" would be
    // false about a root nobody can reach, so the mount's reason wins. `getByRole` throws on two
    // matches, so rendering both lines fails here.
    const { getByRole } = renderPicker(GIT_CAPABILITIES, {
      pendingMode: "provisioned-worktree",
      posture: CONTROLS_HELD_BY_THE_MOUNT,
    });

    expect(getByRole("status").textContent).toBe("This mount is no longer reachable.");
    expect(getByRole("status").textContent).not.toContain("Switching to");
  });

  it("negative control: with nothing pending the rows are live and nothing is announced", () => {
    // Without this the case above would pass against a picker that was always held.
    const { container, queryByRole } = renderPicker(GIT_CAPABILITIES);

    expect(container.querySelector("fieldset")?.disabled).toBe(false);
    expect(queryByRole("status")).toBeNull();
  });

  it("keeps the bound row checked rather than moving the selection to the pending mode", () => {
    // Moving the radio would report a binding the daemon has not confirmed.
    const { container } = renderPicker(GIT_CAPABILITIES, {
      currentMode: "bound-root",
      pendingMode: "provisioned-worktree",
      posture: CONTROLS_HELD_BY_A_SWITCH,
    });
    const checked = [...container.querySelectorAll<HTMLInputElement>("input[type=radio]")].filter(
      (radio) => radio.checked,
    );

    expect(checked.map((radio) => radio.value)).toStrictEqual(["bound-root"]);
  });
});
