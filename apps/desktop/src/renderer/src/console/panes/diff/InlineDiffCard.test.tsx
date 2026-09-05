// The card, and the four clauses of `InlineDiffCard.tsx`'s own rule it implements.
//
// The registration is checked here rather than in `panes/panes.test.ts`, which is
// seat-blind by design: it asserts the seat board's SHAPE and says nothing about
// occupants. Which body fills the `diff` card is this family's claim, so this
// family's test is where it belongs.

import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  inlineCardBody,
  inlineCardSeatRegistry,
  type DiffInlineCardProps,
} from "../../seats/index.js";
import { INLINE_DIFF_CARD_HEIGHT_CAP_PX } from "./diff-bounds.js";
import { buildDiffFixture } from "./diff-fixture.js";
import { SMALL_DIFF_SHAPE } from "./diff-fixture-shapes.js";
import { DIFF_FIXTURE_VIEWPORT_HEIGHT_PX, DiffLayoutFixture } from "./diff-layout-fixture.js";
import { InlineDiffCard, registerInlineDiffCardBody } from "./InlineDiffCard.js";

const CARD: DiffInlineCardProps = {
  kind: "diff",
  runId: "run-rate-limit-wiring",
  diffArtifactId: "diff-artifact-01",
  artifactManifestId: "artifact-manifest-01",
};

const DIFF = buildDiffFixture(SMALL_DIFF_SHAPE);

// The card renders the pane's own virtualized rows, so it needs the same stated
// pane height every diff case does — happy-dom lays nothing out, and a scroller
// with no height correctly holds no rows.
const layout = new DiffLayoutFixture();

beforeEach(() => {
  layout.install({ viewportHeightPx: DIFF_FIXTURE_VIEWPORT_HEIGHT_PX });
});

afterEach(() => {
  layout.restore();
  // The seat registry is process-wide, so a case that registers into it puts it
  // back. Leaving a body behind would make a later case pass because of this
  // one.
  inlineCardSeatRegistry.unregister("diff");
});

describe("inline diff card — the seat", () => {
  it("fills the ledger's diff card body", () => {
    registerInlineDiffCardBody();
    expect(inlineCardBody("diff")?.owner).toBe("repos");
    expect(inlineCardSeatRegistry.registeredCardKinds()).toContain("diff");
  });

  it("renders through the registry the ledger reaches it by", () => {
    registerInlineDiffCardBody();
    const { container } = render(<>{inlineCardSeatRegistry.render(CARD)}</>);
    expect(container.querySelector(".meridian-diff-card")).not.toBeNull();
  });

  it("negative control: the registry answers nothing before the body is registered", () => {
    // Without this, the two cases above would pass over a registry that answered
    // from somewhere else entirely, and the registration call would be doing
    // nothing.
    expect(inlineCardBody("diff")).toBeUndefined();
  });
});

describe("inline diff card — the absence, and the diff", () => {
  it("says the diff has not been read, and never that there is nothing in it", () => {
    const { container } = render(<InlineDiffCard card={CARD} />);
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("names the diff wire-verbatim, with the full string recoverable", () => {
    const { container } = render(<InlineDiffCard card={CARD} />);
    const changeSet = container.querySelector(".meridian-diff-card__change-set");
    expect(changeSet?.textContent).toBe(CARD.diffArtifactId);
    expect(changeSet?.getAttribute("title")).toBe(CARD.diffArtifactId);
  });

  it("negative control: the manifest id is not what the card names itself by", () => {
    // The two identifiers the registered diff result carries are both on the arm, and
    // only one of them is this card's subject. Without this the case above would pass
    // over a card that rendered whichever id it was handed first.
    const { container } = render(<InlineDiffCard card={CARD} />);
    const changeSet = container.querySelector(".meridian-diff-card__change-set");
    expect(changeSet?.textContent).not.toBe(CARD.artifactManifestId);
  });

  it("uses the same renderer the pane uses", () => {
    // Not "a renderer" — THE renderer. `DiffRenderer.tsx`: one implementation, so a
    // one-character edit reads as one character in both surfaces. The rows carry
    // the renderer's own classes, which is what makes this checkable.
    const { container } = render(<InlineDiffCard card={CARD} diff={DIFF} />);
    expect(container.querySelectorAll(".meridian-diff__row--line").length).toBeGreaterThan(0);
  });
});

describe("inline diff card — expanded to the cap, with somewhere to go", () => {
  it("opens expanded at the height cap rather than collapsed", () => {
    const { container } = render(<InlineDiffCard card={CARD} diff={DIFF} />);
    const scroller = container.querySelector<HTMLElement>(".meridian-diff");
    expect(scroller).not.toBeNull();
    expect(scroller?.style.maxBlockSize).toBe(`${String(INLINE_DIFF_CARD_HEIGHT_CAP_PX)}px`);
  });

  it("keeps collapse, and releases the cap in place", () => {
    const { container, getByRole } = render(<InlineDiffCard card={CARD} diff={DIFF} />);
    fireEvent.click(getByRole("button", { name: "Expand in place" }));
    expect(container.querySelector<HTMLElement>(".meridian-diff")?.style.maxBlockSize).toBe("");

    fireEvent.click(getByRole("button", { name: "Collapse" }));
    expect(container.querySelector(".meridian-diff")).toBeNull();
    expect(getByRole("button", { name: "Show diff" })).toBeDefined();
  });

  it("always offers a way past the cap, capped or not", () => {
    // "No capped diff ends in a fade with nowhere to go." Both escape hatches are
    // rendered in both states, so the card's bottom edge never moves under a
    // reader who used one.
    const { getByRole } = render(<InlineDiffCard card={CARD} diff={DIFF} />);
    expect(getByRole("button", { name: "Jump to end" })).toBeDefined();
    fireEvent.click(getByRole("button", { name: "Expand in place" }));
    expect(getByRole("button", { name: "Jump to end" })).toBeDefined();
  });

  it("starts with attribution marks off, one toggle from the pane's default", () => {
    // `DiffToolbar.tsx`'s density rule, and the half of it the card owns. The pane's own test
    // owns the other half; together they are the claim that the two defaults
    // differ rather than that either is a particular value.
    const { container } = render(<InlineDiffCard card={CARD} diff={DIFF} />);
    expect(container.querySelectorAll(".meridian-diff__attribution-mark").length).toBe(0);
  });
});

describe("inline diff card — the one control it carries", () => {
  it("puts attribution marks one toggle away, which is the other half of the density rule", () => {
    const { container, getByRole } = render(<InlineDiffCard card={CARD} diff={DIFF} />);
    expect(container.querySelectorAll(".meridian-diff__attribution-mark").length).toBe(0);
    fireEvent.click(getByRole("button", { name: "Attribution marks" }));
    expect(container.querySelectorAll(".meridian-diff__attribution-mark").length).toBeGreaterThan(
      0,
    );
  });

  it("negative control: it carries that control and not the pane's whole toolbar", () => {
    // A card is read inside a conversation. Four controls of chrome per diff is
    // the density `InlineDiffCard.tsx`'s own rule exists to avoid, and a card that grew the
    // pane's toolbar would pass every other case in this file.
    const { queryByRole } = render(<InlineDiffCard card={CARD} diff={DIFF} />);
    expect(queryByRole("toolbar")).toBeNull();
  });
});
