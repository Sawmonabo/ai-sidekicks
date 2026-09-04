// Every chrome state renders its own shape, and the two grammars stay apart.
//
// The claim is about a SET — five states, five renderings — so the tests drive
// `WORKFLOW_CHROME_STATES` rather than five hand-listed arms beside it. A sixth arm
// added to the union and forgotten here fails the exhaustiveness case rather than
// passing silently, which is the property a hand-listed set cannot have.
//
// The second claim is the one worth a test of its own: a refusal is NOT an absence.
// Both would look like "something is wrong" to a reader skimming the markup, and
// only the refusal carries the daemon's code — so the refusal case asserts the code
// is on screen, and the absence cases assert it is not the shape they took.
//
// The third is about two chromes rather than one, which is why it renders a PAIR into
// one tree: a deck holds two `workflow-run` panes at once, and every single-render
// case in this file passes over a chrome whose heading id is a fact about its copy.
//
// IT LIVES HERE RATHER THAN IN THE ACCESSIBILITY TIER, and that is a measurement
// rather than a preference. A duplicate id carried by `aria-labelledby` reads like
// the accessibility tier's own subject, but `duplicate-id-aria` reports nothing for
// one at the pinned `axe-core` — a planted pair of sections referencing one id comes
// back clean, scoped to the host element and scanned across the document alike — so a
// case mounted there would have asserted an empty list that stays empty however the
// ids come out. This tier resolves the reference itself, the way an IDREF resolves,
// which is the only instrument in the tree that fails on the old code.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../core/index.js";
import { WorkflowChrome } from "./WorkflowChrome.js";
import {
  WORKFLOW_CHROME_STATES,
  refusedWorkflowChrome,
  unaskedWorkflowChrome,
  type WorkflowChromeState,
  type WorkflowChromeStateKind,
} from "./chrome-state.js";

/** One state per arm, so a walk over the closed set can render all five. */
const STATE_BY_KIND: Readonly<Record<WorkflowChromeStateKind, WorkflowChromeState>> = {
  "not-checked": unaskedWorkflowChrome("Nobody asked.", "The read happens elsewhere."),
  "not-loaded": { kind: "not-loaded", title: "Reading." },
  empty: { kind: "empty", title: "Nothing here.", detail: "Make one." },
  refused: refusedWorkflowChrome(
    refuse("workflows-test", "workflow.not_found", "That run is gone. Refresh the list."),
  ),
  ready: { kind: "ready" },
};

function renderChrome(state: WorkflowChromeState): HTMLElement {
  const { container } = render(
    <WorkflowChrome glyph="workflow" heading="Workflows" summary="A summary." state={state}>
      <p data-testid="workflow-body">The body.</p>
    </WorkflowChrome>,
  );
  const section = container.querySelector("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error("the chrome rendered no section");
  }
  return section;
}

/**
 * The element a region's `aria-labelledby` resolves to, the way an IDREF resolves.
 *
 * From the tree the reference lives in, and therefore the FIRST element in document
 * order carrying that id — which is what a browser hands the accessibility tree and
 * what a person is read. The scope is the whole instrument: a lookup performed INSIDE
 * the referring section finds that section's own heading whatever the id says, so two
 * colliding references come back as two correct ones and the pair case below would
 * report the bug it exists to catch as a pass.
 *
 * `CSS.escape` because the id is React's rather than a string this file composed, and
 * React 19 mints one carrying characters a bare selector cannot.
 */
function labelIn(tree: ParentNode, section: HTMLElement): HTMLElement | null {
  const labelledBy = section.getAttribute("aria-labelledby");
  return labelledBy === null ? null : tree.querySelector(`#${CSS.escape(labelledBy)}`);
}

describe("workflow chrome — the header", () => {
  it("names the region by its own visible heading", () => {
    const section = renderChrome(STATE_BY_KIND.ready);
    expect(section.getAttribute("aria-labelledby")).not.toBeNull();
    expect(labelIn(section, section)?.textContent).toBe("Workflows");
  });

  it("renders no primary action when the caller offers none", () => {
    // "Absent, not disabled": a control with nothing behind it is not drawn.
    expect(renderChrome(STATE_BY_KIND.ready).querySelector("button")).toBeNull();
  });

  it("renders the primary action the caller supplies", () => {
    // Negative control for the case above: it would pass over a chrome that never
    // rendered an action at all.
    const { container } = render(
      <WorkflowChrome
        glyph="workflow"
        heading="Workflows"
        summary="A summary."
        state={STATE_BY_KIND.ready}
        primaryAction={<button type="button">New definition</button>}
      />,
    );
    expect(container.querySelector("button")?.textContent).toBe("New definition");
  });
});

describe("workflow chrome — one rendering per state", () => {
  it("renders the body on `ready` and on no other arm", () => {
    for (const kind of WORKFLOW_CHROME_STATES) {
      const section = renderChrome(STATE_BY_KIND[kind]);
      expect([kind, section.querySelector('[data-testid="workflow-body"]') !== null]).toStrictEqual(
        [kind, kind === "ready"],
      );
    }
  });

  it("gives each absence its own kind modifier", () => {
    const modifiers = (["not-checked", "not-loaded", "empty"] as const).map((kind) => {
      const absence = renderChrome(STATE_BY_KIND[kind]).querySelector(".meridian-nothing");
      return [...(absence?.classList ?? [])].find((className) => className.endsWith(`--${kind}`));
    });
    expect(modifiers).toStrictEqual([
      "meridian-nothing--not-checked",
      "meridian-nothing--not-loaded",
      "meridian-nothing--empty",
    ]);
  });

  it("renders a refusal as a refusal, carrying the daemon's code and message", () => {
    const section = renderChrome(STATE_BY_KIND.refused);
    expect(section.querySelector(".meridian-refusal")).not.toBeNull();
    expect(section.textContent).toContain("workflow.not_found");
    expect(section.textContent).toContain("That run is gone. Refresh the list.");
  });

  it("negative control: a refusal is not rendered as an absence", () => {
    // Without this, the absence cases above would still pass over a chrome that
    // routed `refused` into `Nothing`'s error arm — which would drop the code.
    expect(renderChrome(STATE_BY_KIND.refused).querySelector(".meridian-nothing")).toBeNull();
  });
});

describe("workflow chrome — two panes of one kind in one deck", () => {
  /** Two chromes and the tree that holds them, as a deck holds two panes at once. */
  interface RenderedPair {
    readonly tree: HTMLElement;
    readonly sections: readonly HTMLElement[];
  }

  /**
   * Two chromes with identical copy, mounted into one tree.
   *
   * Identical on purpose: the id used to be derived from the heading text, so two
   * panes of one kind is precisely the arrangement that collided, and a pair carrying
   * two different headings would have passed over it.
   */
  function renderPair(): RenderedPair {
    const { container } = render(
      <>
        <WorkflowChrome
          glyph="workflow"
          heading="Workflow run"
          summary="A summary."
          state={STATE_BY_KIND.ready}
        />
        <WorkflowChrome
          glyph="workflow"
          heading="Workflow run"
          summary="A summary."
          state={STATE_BY_KIND.ready}
        />
      </>,
    );
    return { tree: container, sections: [...container.querySelectorAll<HTMLElement>("section")] };
  }

  /** The pair, or a throw naming what was rendered instead. */
  function requirePair(pair: RenderedPair): readonly [HTMLElement, HTMLElement] {
    const [first, second] = pair.sections;
    if (first === undefined || second === undefined) {
      throw new Error(`the pair rendered ${String(pair.sections.length)} regions`);
    }
    return [first, second];
  }

  it("gives each chrome its own heading id", () => {
    const [first, second] = requirePair(renderPair());
    const firstId = first.getAttribute("aria-labelledby");
    expect(firstId).not.toBeNull();
    // A duplicate id is invalid markup before it is anything else, and it is what
    // sends both references to one heading.
    expect(firstId).not.toBe(second.getAttribute("aria-labelledby"));
  });

  it("resolves each reference to that chrome's own heading", () => {
    // The consequence rather than the mechanism: with one id shared, the second
    // region's reference resolves to the FIRST region's heading, so the two panes are
    // announced with one name and neither is addressable by it.
    const pair = renderPair();
    const [first, second] = requirePair(pair);
    const firstLabel = labelIn(pair.tree, first);
    const secondLabel = labelIn(pair.tree, second);
    expect(firstLabel).not.toBeNull();
    expect(secondLabel).not.toBeNull();
    expect(firstLabel).not.toBe(secondLabel);
    expect([first.contains(firstLabel), second.contains(secondLabel)]).toStrictEqual([true, true]);
  });

  it("keeps the accessible name the heading's own text", () => {
    // Negative control for the pair above: distinct ids pointing at nothing, or at
    // headings whose text had been made unique to force them apart, would satisfy
    // both cases while changing what a person hears.
    const pair = renderPair();
    const [first, second] = requirePair(pair);
    expect([
      labelIn(pair.tree, first)?.textContent,
      labelIn(pair.tree, second)?.textContent,
    ]).toStrictEqual(["Workflow run", "Workflow run"]);
  });
});
