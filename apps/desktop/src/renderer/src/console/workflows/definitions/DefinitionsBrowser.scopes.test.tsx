// A scope group says "there are none" only when the enumeration is finished.
//
// The cases read the ABSENCE KINDS the three groups render rather than locating one
// group by name, because the claim is about all of them at once: one read serves the
// resolved union, so whatever a group may say about itself, every group with no rows
// may say the same thing.
//
// This suite is a sibling of `DefinitionsBrowser.test.tsx` rather than a section of it:
// the grouping, resolution and control cases live there, and what a group renders when
// it holds nothing is its own concern with its own reason to change.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { definition } from "../workflows-probe.test-support.js";
import { DefinitionsBrowser } from "./DefinitionsBrowser.js";

/** One row, so a case can hold one scope's group open while the other two are empty. */
const SESSION_DEFINITION = definition({ resolvesAtThisContext: true });

/** How many groups rendered one kind of nothing, which is the whole of every claim here. */
function absencesOfKind(container: HTMLElement, kind: string): number {
  return container.querySelectorAll(`.meridian-workflow__scope .meridian-nothing--${kind}`).length;
}

describe("a group with no rows, while the enumeration has pages left", () => {
  afterEach(() => {
    cleanup();
  });

  it("says what it has read so far and never that there are none", () => {
    // The defect: a first page carrying `nextCursor` and no row for a scope rendered
    // `No <scope> definitions` under it — a definitive claim about a daemon that had
    // just said there was more to come — and stood while the continuation read and
    // again after the daemon refused it.
    const { container } = render(<DefinitionsBrowser definitions={[]} hasUnreadPages />);

    expect(absencesOfKind(container, "empty")).toBe(0);
    expect(absencesOfKind(container, "not-checked")).toBe(3);
  });

  it("leaves the groups that did receive rows showing them", () => {
    // The arm is about groups with nothing in them. A scope the first page filled has an
    // answer for what it holds, whatever the pages beyond it turn out to carry.
    const { container } = render(
      <DefinitionsBrowser definitions={[SESSION_DEFINITION]} hasUnreadPages />,
    );

    expect(container.textContent).toContain("Release checklist");
    expect(absencesOfKind(container, "not-checked")).toBe(2);
    expect(absencesOfKind(container, "empty")).toBe(0);
  });

  it("reads as a wait, not as unread pages, while a page for that scope is in flight", () => {
    // Both facts hold at once during a continuation — pages are unread AND one is
    // arriving — and the wait is the one a person can act on, so it wins.
    const { container } = render(
      <DefinitionsBrowser
        definitions={[]}
        pendingScopes={["session", "project", "shared"]}
        hasUnreadPages
      />,
    );

    expect(absencesOfKind(container, "not-loaded")).toBe(3);
    expect(absencesOfKind(container, "not-checked")).toBe(0);
  });

  it("negative control: an exhausted enumeration lets every empty group say so", () => {
    // Without this, the cases above pass for a browser that never renders the empty
    // arm at all — and a console that has read the whole enumeration would then be
    // unable to report a real empty result, which is an answer it is entitled to give.
    const { container } = render(<DefinitionsBrowser definitions={[]} />);

    expect(absencesOfKind(container, "empty")).toBe(3);
    expect(absencesOfKind(container, "not-checked")).toBe(0);
  });
});
