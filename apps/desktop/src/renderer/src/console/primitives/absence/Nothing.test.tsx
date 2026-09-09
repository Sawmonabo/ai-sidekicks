// Rule 8, made countable — and the placement split, made independent of it.
//
// "Five absences render differently because the operator's next move differs for
// each … A renderer that collapses two of these into one is wrong." That is a claim
// about a SET, so the test drives the set — `NOTHING_KINDS` — rather than five
// hand-listed kinds beside it, and asserts the property a collapse would break:
// five distinct kind modifiers, one per kind, at every placement.
//
// The second claim is the one that shipped wrong. Shape used to be read off the
// kind, so `not-checked` was a badge wherever it was mounted — including in place
// of a whole pane, where a badge reads as a page that failed to finish painting.
// The two questions are now two props, so the tests drive them as a GRID: five
// kinds by two placements, each cell asserting the placement's shape and none of
// them asserting it from the kind. The negative control is the default — a caller
// that names no placement gets exactly what it got before, which is what keeps the
// split from being a silent redesign of every existing call site.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NOTHING_KINDS, NOTHING_PLACEMENTS, Nothing } from "./Nothing.js";

/** Which placement each kind is mounted at when the caller names none. */
const DEFAULT_PLACEMENT_BY_KIND = {
  "not-loaded": "surface",
  empty: "surface",
  error: "surface",
  "not-checked": "inline",
  computing: "inline",
} as const;

/** What each placement renders as: the tag, and the shape modifier that goes with it. */
const SHAPE_BY_PLACEMENT = {
  inline: { tagName: "SPAN", modifier: "meridian-nothing--badge" },
  surface: { tagName: "DIV", modifier: "meridian-nothing--block" },
} as const;

function renderNothing(element: React.JSX.Element): HTMLElement {
  const { container } = render(element);
  const nothing = container.firstElementChild;
  if (!(nothing instanceof HTMLElement)) {
    throw new Error("Nothing rendered no element");
  }
  return nothing;
}

/** The kind modifier on a rendered absence, with the shape modifiers discounted. */
function kindModifierOf(rendered: HTMLElement): string {
  const shapeModifiers = NOTHING_PLACEMENTS.map(
    (placement) => SHAPE_BY_PLACEMENT[placement].modifier,
  );
  return (
    [...rendered.classList].find(
      (className) =>
        className.startsWith("meridian-nothing--") &&
        !shapeModifiers.some((shapeModifier) => shapeModifier === className),
    ) ?? ""
  );
}

describe("Nothing — five absences, and no two of them the same", () => {
  it("gives every kind in the set its own modifier class, at either placement", () => {
    for (const placement of NOTHING_PLACEMENTS) {
      const modifiers = NOTHING_KINDS.map((kind) =>
        kindModifierOf(renderNothing(<Nothing kind={kind} placement={placement} title="None" />)),
      );

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
    }
    expect(NOTHING_KINDS).toHaveLength(5);
  });
});

describe("Nothing — shape follows placement, and placement alone", () => {
  it("renders the placement's shape for every kind in the set", () => {
    // The grid, in full: no cell of it reads the kind to decide the shape, which is
    // the whole claim. `not-checked` at `surface` is the cell that used to be
    // impossible — a badge centred in a pane — and it is not called out here,
    // because a rule that needs its hardest case called out is a rule with an
    // exception in it.
    for (const placement of NOTHING_PLACEMENTS) {
      const shape = SHAPE_BY_PLACEMENT[placement];
      for (const kind of NOTHING_KINDS) {
        const rendered = renderNothing(
          <Nothing kind={kind} placement={placement} title="Nothing here" />,
        );
        expect(rendered.tagName).toBe(shape.tagName);
        expect(rendered.classList.contains(shape.modifier)).toBe(true);
        // Exactly one shape, never both and never neither.
        const carried = NOTHING_PLACEMENTS.filter((candidate) =>
          rendered.classList.contains(SHAPE_BY_PLACEMENT[candidate].modifier),
        );
        expect(carried).toStrictEqual([placement]);
      }
    }
    expect(NOTHING_PLACEMENTS).toHaveLength(2);
  });

  it("negative control: a caller that names no placement renders what it did before", () => {
    // Without this the grid above would pass over a component that had quietly made
    // every absence a block, which would move every existing call site — and the
    // screenshot tier is the only thing that would ever have noticed.
    for (const kind of NOTHING_KINDS) {
      const rendered = renderNothing(<Nothing kind={kind} title="Nothing here" />);
      const shape = SHAPE_BY_PLACEMENT[DEFAULT_PLACEMENT_BY_KIND[kind]];
      expect(rendered.tagName).toBe(shape.tagName);
      expect(rendered.classList.contains(shape.modifier)).toBe(true);
    }
    // `not-checked` by name, because it is the default the fix could most easily
    // have taken with it: rule 8 names a dotted BADGE, and it is still one here.
    const notChecked = renderNothing(<Nothing kind="not-checked" title="Not checked" />);
    expect(notChecked.tagName).toBe("SPAN");
    expect(notChecked.classList.contains("meridian-nothing--badge")).toBe(true);
    expect(notChecked.classList.contains("meridian-nothing--block")).toBe(false);
  });

  it("keeps the kind's copy, glyph, and tone across both shapes", () => {
    // The other half of the split: if placement took the glyph or the second line
    // with it, the shape would still be right and the kind would have been diluted.
    const surfaceComputing = renderNothing(
      <Nothing kind="computing" placement="surface" title="Working it out" detail="Still going." />,
    );
    expect(surfaceComputing.querySelector("svg")).not.toBeNull();
    expect(surfaceComputing.getAttribute("role")).toBe("status");
    expect(surfaceComputing.classList.contains("meridian-nothing--computing")).toBe(true);
    // A block has room for the second line, so it is prose rather than a tooltip.
    expect(surfaceComputing.querySelector(".meridian-nothing__detail")?.textContent).toBe(
      "Still going.",
    );

    const inlineError = renderNothing(
      <Nothing kind="error" placement="inline" title="The read failed" detail="node.refused" />,
    );
    expect(inlineError.querySelector("svg")).not.toBeNull();
    expect(inlineError.getAttribute("role")).toBe("status");
    expect(inlineError.querySelector(".meridian-nothing__badge-label")?.getAttribute("title")).toBe(
      "node.refused",
    );
  });

  it("says nothing at either shape while the read is in flight", () => {
    // `not-loaded` is the one kind whose copy is a shape rather than a sentence, so
    // it is the one kind a placement split could have made speak.
    for (const placement of NOTHING_PLACEMENTS) {
      const rendered = renderNothing(
        <Nothing kind="not-loaded" placement={placement} title="Loading" detail="Ignored." />,
      );
      expect(rendered.getAttribute("aria-busy")).toBe("true");
      expect(rendered.textContent).toBe("Loading");
      expect(rendered.querySelectorAll(".meridian-nothing__skeleton-bar").length).toBeGreaterThan(
        0,
      );
    }
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
