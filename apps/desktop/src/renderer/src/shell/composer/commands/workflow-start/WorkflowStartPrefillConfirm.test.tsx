// The question a prefill asks before it takes somebody's line, and its two answers.
//
// One question, two acts, and they must not both fire: closing is what KEEPS the
// line, so a Replace routed through the dialog's own close part would run both
// answers and leave which one won to event ordering. That is what the last case here
// holds, and it is the reason Replace is a plain button.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkflowStartPrefillConfirm } from "./WorkflowStartPrefillConfirm.js";

const DIALOG_TITLE = "Replace what you have typed?";

/** The dialog with both answers watched, mounted for one pending decision. */
function renderConfirm(displacedText: string | undefined) {
  const replaceLine = vi.fn();
  const keepLine = vi.fn();
  render(
    <WorkflowStartPrefillConfirm
      displacedText={displacedText}
      replaceLine={replaceLine}
      keepLine={keepLine}
    />,
  );
  return { replaceLine, keepLine };
}

describe("WorkflowStartPrefillConfirm", () => {
  it("renders nothing at all while no decision is pending", () => {
    renderConfirm(undefined);

    expect(screen.queryByText(DIALOG_TITLE)).toBeNull();
  });

  it("shows the text that would go, as the user's own bytes", () => {
    // A count or a paraphrase describes a thing; what a person needs to decide is
    // the thing itself.
    renderConfirm("  ship the parser fix  ");

    expect(screen.getByText(DIALOG_TITLE)).not.toBeNull();
    expect(screen.getByText("ship the parser fix").textContent).toBe("  ship the parser fix  ");
  });

  it("replaces the line only on the explicit act", () => {
    const { replaceLine, keepLine } = renderConfirm("ship the parser fix");

    fireEvent.click(screen.getByText("Replace it"));

    expect(replaceLine).toHaveBeenCalledTimes(1);
    // The negative control for the double-settlement hazard: routed through the
    // dialog's close part, this press would have kept the line as well as replaced
    // it, and which answer won would be event ordering.
    expect(keepLine).not.toHaveBeenCalled();
  });

  it("keeps the line on the dismissing answer, and replaces nothing", () => {
    const { replaceLine, keepLine } = renderConfirm("ship the parser fix");

    fireEvent.click(screen.getByText("Keep what I typed"));

    expect(keepLine).toHaveBeenCalledTimes(1);
    expect(replaceLine).not.toHaveBeenCalled();
  });
});
