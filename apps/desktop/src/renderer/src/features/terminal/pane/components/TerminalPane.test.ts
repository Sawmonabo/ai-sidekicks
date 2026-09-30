// The pane's one decision: bound to a session, or honestly not. Everything after the binding
// is the bound half's; this file owns the arm with no store, so no terminal.

import { describe, expect, it } from "vitest";

import { renderPane } from "./TerminalPane.test-support.js";

describe("terminal pane — a pane opened without a session", () => {
  it("is named by the trail it sits on rather than by its kind alone", () => {
    // Through `aria-labelledby`, not `aria-label`: `PaneFrame` names every pane by its whole
    // address trail. With no session the trail opens on the chrome's no-address crumb.
    const region = renderPane(undefined);
    const crumbs = document.getElementById(region.getAttribute("aria-labelledby") ?? "");

    expect(region.getAttribute("aria-label")).toBeNull();
    expect(crumbs?.textContent).toBe("No sessionTerminal");
  });

  it("says it is unbound rather than showing a terminal that belongs to nobody", () => {
    const region = renderPane(undefined);
    const absence = region.querySelector(".meridian-nothing");
    expect(absence?.className).toContain("meridian-nothing--not-checked");
    expect(absence?.className).toContain("meridian-nothing--block");
    expect(region.textContent).toContain("not bound to a session");
    // Not "this session has no terminal", which would claim something about a session the
    // pane was never given.
    expect(region.textContent).toContain("only that none was addressed");
  });

  it("mounts no emulator it has no session to address", () => {
    expect(renderPane(undefined).querySelector(".meridian-terminal-mount-point")).toBeNull();
  });
});
