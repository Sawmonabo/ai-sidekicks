// Rule 8, made countable.
//
// "Five absences render differently because the operator's next move differs for
// each … A renderer that collapses two of these into one is wrong." That is a claim
// about a SET, so the test drives the set — `NOTHING_KINDS` — rather than five
// hand-listed kinds beside it, and asserts the two properties a collapse would
// break: five distinct modifier classes, and the badge/block split that separates
// "this value is qualified" from "this surface is not here".

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NOTHING_KINDS, Nothing } from "./Nothing.js";

/** Which kinds qualify a value beside them, and which stand in for a surface. */
const BADGE_KINDS = ["not-checked", "computing"] as const;

function renderNothing(element: React.JSX.Element): HTMLElement {
  const { container } = render(element);
  const nothing = container.firstElementChild;
  if (!(nothing instanceof HTMLElement)) {
    throw new Error("Nothing rendered no element");
  }
  return nothing;
}

describe("Nothing — five absences, and no two of them the same", () => {
  it("gives every kind in the set its own modifier class", () => {
    const modifiers = NOTHING_KINDS.map((kind) => {
      const rendered = renderNothing(<Nothing kind={kind} title="Nothing here" />);
      return (
        [...rendered.classList].find(
          (className) =>
            className.startsWith("meridian-nothing--") && className !== "meridian-nothing--badge",
        ) ?? ""
      );
    });

    expect(modifiers).toStrictEqual([
      "meridian-nothing--not-loaded",
      "meridian-nothing--empty",
      "meridian-nothing--error",
      "meridian-nothing--not-checked",
      "meridian-nothing--computing",
    ]);
    // The control for "a renderer that collapses two of these is wrong": five
    // entries that are not five DISTINCT entries is exactly that collapse.
    expect(new Set(modifiers).size).toBe(NOTHING_KINDS.length);
    expect(NOTHING_KINDS).toHaveLength(5);
  });

  it("splits the set into badges that qualify a value and blocks that replace one", () => {
    for (const kind of NOTHING_KINDS) {
      const rendered = renderNothing(<Nothing kind={kind} title="Nothing here" />);
      const isBadge = BADGE_KINDS.some((badgeKind) => badgeKind === kind);
      expect(rendered.tagName).toBe(isBadge ? "SPAN" : "DIV");
      expect(rendered.classList.contains("meridian-nothing--badge")).toBe(isBadge);
    }
    // The split partitions the set — it does not merely sample it.
    expect(BADGE_KINDS).toHaveLength(NOTHING_KINDS.length - 3);
  });
});

describe("Nothing — each kind says what its own next move needs", () => {
  it("says nothing visible while the read is in flight", () => {
    // A sentence here would be replaced a beat later, so the title is announced and
    // the shape is skeleton bars in the row's own proportions.
    const notLoaded = renderNothing(<Nothing kind="not-loaded" title="Loading the sessions" />);
    expect(notLoaded.getAttribute("aria-busy")).toBe("true");
    expect(notLoaded.querySelectorAll(".meridian-nothing__skeleton-bar")).toHaveLength(3);
    expect(notLoaded.querySelector(".meridian-visually-hidden")?.textContent).toBe(
      "Loading the sessions",
    );
    // The control: the bars are uneven on purpose — three equal bars read as a
    // table, and the shape being imitated is a ledger row.
    const barWidths = [...notLoaded.querySelectorAll(".meridian-nothing__skeleton-bar")].map(
      (bar) => (bar instanceof HTMLElement ? bar.style.width : ""),
    );
    expect(new Set(barWidths).size).toBe(barWidths.length);
  });

  it("renders the daemon's own message on the error kind rather than a paraphrase", () => {
    const daemonMessage = "  The runtime node refused: runtimenode.permission_denied  ";
    const error = renderNothing(
      <Nothing kind="error" title="The read failed" detail={daemonMessage} />,
    );
    expect(error.querySelector(".meridian-nothing__message")?.textContent).toBe(daemonMessage);
    expect(error.querySelector(".meridian-nothing__message")?.textContent).not.toBe(
      daemonMessage.trim(),
    );
  });

  it("keeps `not-checked` distinct from an answer nobody has", () => {
    // "No question was put" is neither "no" nor "we do not know", and the two badge
    // kinds have to be told apart by more than their copy: only `computing` carries
    // the clock glyph and the live region, because only it is in progress.
    const notChecked = renderNothing(<Nothing kind="not-checked" title="Not checked" />);
    const computing = renderNothing(<Nothing kind="computing" title="Working it out" />);

    expect(notChecked.querySelector("svg")).toBeNull();
    expect(notChecked.getAttribute("role")).toBeNull();
    expect(computing.querySelector("svg")).not.toBeNull();
    expect(computing.getAttribute("role")).toBe("status");
  });

  it("carries the escape hatch on `empty`, where creating one is the next move", () => {
    const empty = renderNothing(
      <Nothing
        kind="empty"
        title="No sessions yet"
        detail="Start one to see it here."
        action={<button type="button">New session</button>}
      />,
    );
    expect(empty.querySelector(".meridian-nothing__action button")?.textContent).toBe(
      "New session",
    );
    expect(empty.querySelector(".meridian-nothing__detail")?.textContent).toBe(
      "Start one to see it here.",
    );
    expect(
      renderNothing(<Nothing kind="empty" title="No sessions yet" />).querySelector(
        ".meridian-nothing__action",
      ),
    ).toBeNull();
  });
});
