// The frame the chrome draws: its two total tables, its name and its key claim. Driven from
// `PANE_KINDS` so a new kind fails here. The host's controls are in `PaneFrame.controls.test.tsx`.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PaneFrame, GLYPH_BY_PANE_KIND, TITLE_BY_PANE_KIND } from "./PaneFrame.js";
import { renderPaneFrame } from "./PaneFrame.test-support.js";
import { PANE_KINDS } from "@renderer/routing/panes/pane-kinds.js";

/** The element the pane names itself by, resolved the way an assistive reader does. */
function accessibleName(pane: HTMLElement): string {
  const labelledBy = pane.getAttribute("aria-labelledby");
  if (labelledBy === null) {
    throw new Error("the pane names itself by nothing");
  }
  const naming = pane.ownerDocument.getElementById(labelledBy);
  if (naming === null) {
    throw new Error(`the pane names itself by "${labelledBy}", which is on no element`);
  }
  return naming.textContent ?? "";
}

describe("PaneFrame — every declared kind has a frame", () => {
  it("names a glyph and a title for every pane kind, so no kind falls back", () => {
    expect(Object.keys(GLYPH_BY_PANE_KIND).sort()).toStrictEqual([...PANE_KINDS].sort());
    expect(Object.keys(TITLE_BY_PANE_KIND).sort()).toStrictEqual([...PANE_KINDS].sort());
  });

  it("names and draws every pane kind", () => {
    for (const kind of PANE_KINDS) {
      const pane = renderPaneFrame(
        <PaneFrame kind={kind} sessionId="session-1" entity={undefined}>
          <p>body</p>
        </PaneFrame>,
      );
      const crumbs = [...pane.querySelectorAll("li")].map((crumb) => crumb.textContent);
      // Two crumbs: the session, then the pane's own name, which the chrome supplies.
      expect(crumbs, kind).toStrictEqual(["session-1", TITLE_BY_PANE_KIND[kind]]);
      expect(crumbs[1], kind).not.toBe(kind);
      expect(pane.querySelector(".meridian-pane__kind svg"), kind).not.toBeNull();
      expect(pane.className, kind).toContain(`meridian-pane--${kind}`);
    }
  });

  it("negative control: the two tables are not one table", () => {
    // Negative control: a table answering the wire-shaped kind string would also satisfy this.
    expect(TITLE_BY_PANE_KIND["workflow-run"]).toBe("Workflow run");
    expect(Object.values(TITLE_BY_PANE_KIND)).not.toContain("workflow-run");
  });
});

describe("PaneFrame — how the pane names itself", () => {
  it("is named by its whole trail, so two panes of one kind differ", () => {
    const workflowRunPane = renderPaneFrame(
      <PaneFrame kind="workflow-run" sessionId="session-1" runId="run-01">
        <p>body</p>
      </PaneFrame>,
    );
    expect(accessibleName(workflowRunPane)).toContain("session-1");
    expect(accessibleName(workflowRunPane)).toContain("run-01");
    expect(accessibleName(workflowRunPane)).toContain("Workflow run");
  });

  it("negative control: two workflow-run panes at different addresses are named differently", () => {
    // Negative control: a chrome named by its title alone would pass the case above.
    const first = renderPaneFrame(
      <PaneFrame kind="workflow-run" sessionId="session-1" runId="run-01">
        <p>body</p>
      </PaneFrame>,
    );
    const second = renderPaneFrame(
      <PaneFrame kind="workflow-run" sessionId="session-1" runId="run-02">
        <p>body</p>
      </PaneFrame>,
    );
    expect(accessibleName(first)).not.toBe(accessibleName(second));
  });

  it("mints its own id when the caller has none to give", () => {
    const pane = renderPaneFrame(
      <PaneFrame kind="diff" sessionId="session-1">
        <p>body</p>
      </PaneFrame>,
    );
    expect(pane.getAttribute("aria-labelledby")).not.toBe("");
    expect(accessibleName(pane)).toContain("Review");
  });

  it("takes the caller's id where the caller owns one", () => {
    const pane = renderPaneFrame(
      <PaneFrame kind="diff" headingId="host-owned-heading" sessionId="session-1">
        <p>body</p>
      </PaneFrame>,
    );
    expect(pane.getAttribute("aria-labelledby")).toBe("host-owned-heading");
  });

  it("negative control: two minted ids do not collide", () => {
    // Two panes of one kind are common; a literal id would point both at the first.
    const { container } = render(
      <>
        <PaneFrame kind="terminal" sessionId="session-1">
          <p>one</p>
        </PaneFrame>
        <PaneFrame kind="terminal" sessionId="session-2">
          <p>two</p>
        </PaneFrame>
      </>,
    );
    const ids = [...container.querySelectorAll(".meridian-pane")].map((pane) =>
      pane.getAttribute("aria-labelledby"),
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("PaneFrame — focus", () => {
  it("is reachable programmatically without spending a tab stop", () => {
    const pane = renderPaneFrame(
      <PaneFrame kind="agents" sessionId="session-1">
        <p>body</p>
      </PaneFrame>,
    );
    expect(pane.tabIndex).toBe(-1);
    pane.focus();
    expect(pane.ownerDocument.activeElement).toBe(pane);
  });
});

describe("PaneFrame — the pane-level key claim", () => {
  /** A chrome whose key claim records every key it heard, in order. */
  function renderClaiming(heard: string[], children: React.ReactNode): HTMLElement {
    return renderPaneFrame(
      <PaneFrame
        kind="browser"
        sessionId="session-1"
        onKeyDownCapture={(event) => {
          heard.push(event.key);
        }}
      >
        {children}
      </PaneFrame>,
    );
  }

  it("hears a key pressed on the head, which is not inside the body", () => {
    // A wrapped body would hear the key but not the head, where the drag handle and controls live.
    const heard: string[] = [];
    const pane = renderClaiming(heard, <p>the browser body</p>);
    const head = pane.querySelector(".meridian-pane__head");
    if (!(head instanceof HTMLElement)) {
      throw new Error("the chrome drew no head for a key to be pressed on");
    }

    fireEvent.keyDown(head, { key: "w", ctrlKey: true });

    expect(heard).toStrictEqual(["w"]);
  });

  it("hears one pressed in the body too, so the claim covers the whole pane", () => {
    const heard: string[] = [];
    const pane = renderClaiming(heard, <input aria-label="address" />);
    const field = pane.querySelector("input");
    if (field === null) {
      throw new Error("the body rendered no field for a key to be pressed in");
    }

    fireEvent.keyDown(field, { key: "w", ctrlKey: true });

    expect(heard).toStrictEqual(["w"]);
  });

  it("negative control: a chrome given no handler binds nothing", () => {
    // Negative control: an always-attached listener would claim keys for a pane that asked for
    // none.
    const pane = renderPaneFrame(
      <PaneFrame kind="browser" sessionId="session-1">
        <input aria-label="address" />
      </PaneFrame>,
    );
    const field = pane.querySelector("input");
    if (field === null) {
      throw new Error("the body rendered no field for a key to be pressed in");
    }

    expect(() => {
      fireEvent.keyDown(field, { key: "w", ctrlKey: true });
    }).not.toThrow();
  });
});
