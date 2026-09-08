// The row control that opens a change set: what it hands back, and what it names.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OpenDiffControl, type OpenDiffSubject } from "./OpenDiffControl.js";

const WORKSPACE: OpenDiffSubject = { kind: "workspace", id: "workspace-01" };

describe("OpenDiffControl", () => {
  it("hands the row's own subject back, kind and id together", () => {
    const onOpenDiff = vi.fn();
    const { getByRole } = render(<OpenDiffControl subject={WORKSPACE} onOpenDiff={onOpenDiff} />);
    fireEvent.click(getByRole("button"));
    expect(onOpenDiff).toHaveBeenCalledWith(WORKSPACE);
  });

  it("negative control: two rows on one card are told apart by name and not by position", () => {
    // A mount with three workspaces draws three of these, and a name of "Changes"
    // alone would be three identical controls to anyone reading by accessible name.
    const { getByLabelText } = render(
      <>
        <OpenDiffControl subject={WORKSPACE} onOpenDiff={() => undefined} />
        <OpenDiffControl
          subject={{ kind: "worktree", id: "worktree-01" }}
          onOpenDiff={() => undefined}
        />
      </>,
    );
    expect(getByLabelText("Open the changes of workspace workspace-01")).toBeDefined();
    expect(getByLabelText("Open the changes of worktree worktree-01")).toBeDefined();
  });
});
