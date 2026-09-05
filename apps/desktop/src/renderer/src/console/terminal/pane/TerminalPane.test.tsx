// The pane's one decision: bound to a session, or honestly not.
//
// WHAT EARNS A TEST HERE. `TerminalPane.tsx` is 50 lines and makes exactly one call —
// whether there is a session to address — and mounts `BoundTerminalPane` when there
// is. Everything after that binding is the bound half's, and its cases sit beside it.
// This file owns the arm the bound half never sees: no store, so no terminal, and a
// sentence saying which of the two absences that is.

import { describe, expect, it } from "vitest";

import { renderPane } from "./TerminalPane.test-support.js";

describe("terminal pane — a pane opened without a session", () => {
  it("names itself, so the pane is reachable by name", () => {
    expect(renderPane(undefined).getAttribute("aria-label")).toBe("Terminal");
  });

  it("says it is unbound rather than showing a terminal that belongs to nobody", () => {
    const region = renderPane(undefined);
    const absence = region.querySelector(".meridian-nothing");
    expect(absence?.className).toContain("meridian-nothing--not-checked");
    expect(absence?.className).toContain("meridian-nothing--block");
    expect(region.textContent).toContain("not bound to a session");
    // Not "this session has no terminal", which is a claim about a session the
    // pane was never given.
    expect(region.textContent).toContain("only that none was addressed");
  });

  it("mounts no emulator it has no session to address", () => {
    expect(renderPane(undefined).querySelector(".meridian-terminal-host")).toBeNull();
  });
});
