// The picker renders the reply and never re-derives it.
//
// Two of `Spec-023 §Console Design (Meridian)` §10.2's Nevers are testable as
// negative controls, and both are here: `availableModes` is never computed as
// "everything not in `restrictions`", and `defaultMode` is never treated as the
// current mode. The first is what the fourth-mode case below fails on; the second is
// what the two-tag case fails on.

import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts";
import { render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ExecutionModePicker } from "./ExecutionModePicker.js";

const GIT_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["read-only", "branch", "worktree", "ephemeral clone"],
  defaultMode: "worktree",
};

const PLAIN_DIRECTORY_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["read-only"],
  defaultMode: "read-only",
  restrictions: {
    branch: "no git repository at the mount root",
    worktree: "no git repository at the mount root",
    "ephemeral clone": "no git repository at the mount root",
  },
};

function renderPicker(
  capabilities: WorkspaceExecutionModeCapabilitiesReadResponse | undefined,
  overrides: Partial<React.ComponentProps<typeof ExecutionModePicker>> = {},
): ReturnType<typeof render> {
  return render(
    <ExecutionModePicker
      workspaceId="workspace-1"
      currentMode="read-only"
      capabilities={capabilities}
      refusal={undefined}
      disabled={false}
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
      "read-only",
      "branch",
      "worktree",
      "ephemeral clone",
    ]);
    expect([...radios].every((radio) => !radio.disabled)).toBe(true);
  });

  it("renders a disabled row per restricted mode, carrying the daemon's own reason", () => {
    const { container, getAllByText } = renderPicker(PLAIN_DIRECTORY_CAPABILITIES);
    const radios = container.querySelectorAll<HTMLInputElement>("input[type=radio]");
    expect([...radios].map((radio) => radio.value)).toStrictEqual([
      "read-only",
      "branch",
      "worktree",
      "ephemeral clone",
    ]);
    expect([...radios].filter((radio) => radio.disabled).map((radio) => radio.value)).toStrictEqual(
      ["branch", "worktree", "ephemeral clone"],
    );
    // Verbatim, three times — one per restricted mode, beside the row it is about.
    expect(getAllByText("no git repository at the mount root")).toHaveLength(3);
  });

  it("negative control: a mode named in neither half of the reply gets no row", () => {
    // The guard against "everything not in `restrictions`". A picker that started from
    // a hardcoded four-mode list would still draw `branch`, `worktree`, and
    // `ephemeral clone` here — with no reason beside them, which is the silent
    // substitution `Spec-009 §Fallback Behavior` forbids.
    const { container } = renderPicker({ availableModes: ["read-only"], defaultMode: "read-only" });
    const radios = container.querySelectorAll<HTMLInputElement>("input[type=radio]");
    expect([...radios].map((radio) => radio.value)).toStrictEqual(["read-only"]);
  });
});

describe("ExecutionModePicker — default is not current", () => {
  it("labels the default row and the bound row separately", () => {
    const { container } = renderPicker(GIT_CAPABILITIES);
    const rows = container.querySelectorAll(".meridian-mode-picker__row");
    const readOnlyRow = rows[0];
    const worktreeRow = rows[2];
    expect(readOnlyRow).toBeDefined();
    expect(worktreeRow).toBeDefined();
    expect(within(readOnlyRow as HTMLElement).getByText("bound now")).toBeDefined();
    expect(
      within(worktreeRow as HTMLElement).getByText("default for the next writable coding run"),
    ).toBeDefined();
  });

  it("negative control: the bound row does not also claim to be the default", () => {
    // `defaultMode` here is `worktree` while the workspace is bound `read-only`. A
    // renderer that read one field for both would put both tags on one row, which is
    // how a reader comes to believe a writable mode is already in force.
    const { container } = renderPicker(GIT_CAPABILITIES);
    const readOnlyRow = container.querySelectorAll(".meridian-mode-picker__row")[0];
    expect(
      within(readOnlyRow as HTMLElement).queryByText("default for the next writable coding run"),
    ).toBeNull();
  });
});

describe("ExecutionModePicker — refusals and absences", () => {
  it("says nobody asked when there is no reply, rather than showing no modes", () => {
    const { container } = renderPicker(undefined);
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(container.querySelectorAll("input[type=radio]")).toHaveLength(0);
  });

  it("renders the daemon's refusal beside the control, leaving the control in place", () => {
    const { container, getByText } = renderPicker(GIT_CAPABILITIES, {
      refusal: {
        code: "workspace.mode_unsupported",
        detail: "worktree is unavailable while the workspace is stale",
        origin: "repos",
      },
    });
    expect(getByText("workspace.mode_unsupported")).toBeDefined();
    // Rule 9: a refusal never hides the control that produced it.
    expect(container.querySelectorAll("input[type=radio]")).toHaveLength(4);
  });

  it("sends exactly one selection per change, and never one of its own", () => {
    const onSelect = vi.fn();
    const { container } = renderPicker(GIT_CAPABILITIES, { onSelect });
    expect(onSelect).not.toHaveBeenCalled();
    const worktree = container.querySelector<HTMLInputElement>('input[value="worktree"]');
    worktree?.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("worktree");
  });

  it("disables the whole group when the mount withholds its bind controls", () => {
    const { container } = renderPicker(GIT_CAPABILITIES, { disabled: true });
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
  });
});
