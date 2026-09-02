// The terminal pane's shell renders the absence that is true, and offers nothing it
// cannot back.
//
// Two things would be wrong here and both would look right. Rendering `empty` would
// say the lease is free, which `Spec-023 §Console Design (Meridian)` 8.8 makes an
// explicit state a read establishes — and the console has read nothing. Offering a
// claim control would be worse: 8.8 forbids deriving the holder from anything but
// the wire field, and a control with no lease state behind it is a derivation with
// no input. So the shell has no button, and this file is what keeps it that way.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TerminalPane } from "./TerminalPane.js";

function renderTerminalPane(): HTMLElement {
  const { container } = render(<TerminalPane />);
  const region = container.querySelector("section");
  if (!(region instanceof HTMLElement)) {
    throw new Error("TerminalPane rendered no region");
  }
  return region;
}

describe("terminal pane shell", () => {
  it("names itself, so the pane is reachable by name", () => {
    expect(renderTerminalPane().getAttribute("aria-label")).toBe("Terminal");
  });

  it("renders the not-checked absence, mounted as a surface", () => {
    const absence = renderTerminalPane().querySelector(".meridian-nothing");
    expect(absence?.className).toContain("meridian-nothing--not-checked");
    expect(absence?.className).toContain("meridian-nothing--block");
  });

  it("separates an unread lease from a free one, in words", () => {
    expect(renderTerminalPane().textContent).toContain("has not been read");
    expect(renderTerminalPane().textContent).toContain("not the same as the lease being free");
  });

  it("offers no control it cannot back", () => {
    // A claim control here would have no lease state to compare against and no
    // transition to render, so pressing it could only assert a state the console
    // has never read.
    expect(renderTerminalPane().querySelectorAll("button")).toHaveLength(0);
  });

  it("negative control: it does not render the absence that would look finished", () => {
    const absence = renderTerminalPane().querySelector(".meridian-nothing");
    expect(absence?.className).not.toContain("meridian-nothing--empty");
    expect(renderTerminalPane().textContent).not.toContain("The lease is free");
  });
});
