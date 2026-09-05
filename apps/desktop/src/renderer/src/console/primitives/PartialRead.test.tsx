// The notices, rendered — and the one thing they must never do.
//
// The model's test proves the sentence set; this proves the box. Four claims: a set
// of served readings renders nothing at all, every other state renders something a
// person can see, the cause reaches the screen through the refusal primitive rather
// than as prose this component wrote, and the tree carries exactly one live region
// per notice — the one the nested primitive already owns.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../core/index.js";
import { PartialRead } from "./PartialRead.js";
import { READING_STATE_KINDS, type ReadingState, type ReadingStateKind } from "./partial-read.js";

const SUBJECT = "the queue";

const PARSE_REFUSAL = refuse(
  "session-queue",
  "delivery-unreadable",
  "A queue delivery did not match the registered row shape.",
);

const STATE_BY_KIND: Readonly<Record<ReadingStateKind, ReadingState>> = {
  served: { kind: "served" },
  reading: { kind: "reading" },
  refused: { kind: "refused", scope: "beside-an-answer", refusal: PARSE_REFUSAL },
  stale: { kind: "stale", refusal: PARSE_REFUSAL },
  partial: { kind: "partial", unreadableCount: 3, newestRefusal: PARSE_REFUSAL },
  cut: { kind: "cut", servedCount: 12 },
  unchecked: { kind: "unchecked", uncheckedCount: 4, newestRefusal: PARSE_REFUSAL },
};

/** Every element that is a live region, however it is spelled. */
function liveRegions(container: HTMLElement): readonly Element[] {
  return [...container.querySelectorAll('[role="status"], [role="alert"], [aria-live]')];
}

function renderNotice(...states: readonly ReadingState[]): HTMLElement {
  const { container } = render(<PartialRead states={states} subject={SUBJECT} />);
  return container;
}

describe("PartialRead — a surface says less than complete, never more", () => {
  it("renders nothing when every reading served", () => {
    expect(renderNotice({ kind: "served" }, { kind: "served" }).innerHTML).toBe("");
  });

  it("renders something visible for every other state", () => {
    for (const kind of READING_STATE_KINDS) {
      if (kind === "served") {
        continue;
      }
      const container = renderNotice(STATE_BY_KIND[kind]);
      expect(container.innerHTML, `the ${kind} state rendered nothing`).not.toBe("");
    }
  });

  it("mounts one notice per reading a surface holds", () => {
    // The mechanism, not the discipline: a served snapshot beside an unreadable tail
    // is one notice, and two incomplete readings are two.
    const container = renderNotice(
      { kind: "served" },
      STATE_BY_KIND.partial,
      STATE_BY_KIND.refused,
    );
    expect(container.querySelectorAll(".meridian-partial-read").length).toBe(2);
  });

  it("negative control: the emptiness check reads the real tree", () => {
    // Without this an assertion on `innerHTML` could be satisfied by a container
    // that was never rendered into at all, which would make the clean result above
    // true of any component whatsoever.
    expect(renderNotice(STATE_BY_KIND.partial).innerHTML).toContain("meridian-partial-read");
  });
});

describe("PartialRead — what each arm puts on screen", () => {
  it("carries the refusal's code through the refusal primitive", () => {
    const container = renderNotice(STATE_BY_KIND.refused);
    const code = container.querySelector(".meridian-refusal .meridian-figure--wire");
    expect(code?.textContent).toBe(PARSE_REFUSAL.code);
    expect(container.textContent).toContain(PARSE_REFUSAL.detail);
  });

  it("carries the count as a derived figure and never as a wire one", () => {
    // Rule 4: the console counted these, so the count must not wear the wire
    // signature. The refusal beneath it still does, which is why the assertion is
    // scoped to the copy line.
    const copy = renderNotice(STATE_BY_KIND.partial).querySelector(".meridian-partial-read__copy");
    expect(copy?.querySelector(".meridian-figure--derived")?.textContent).toBe("3");
    expect(copy?.querySelector(".meridian-figure--wire")).toBeNull();
  });

  it("leads a whole-sentence arm with no figure at all", () => {
    const copy = renderNotice(STATE_BY_KIND.stale).querySelector(".meridian-partial-read__copy");
    expect(copy?.querySelector(".meridian-figure--derived")).toBeNull();
    expect(copy?.textContent?.startsWith("Some of what arrived")).toBe(true);
  });

  it("renders the in-flight read as the not-loaded absence and not as prose", () => {
    const container = renderNotice(STATE_BY_KIND.reading);
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
    expect(container.querySelector(".meridian-partial-read")).toBeNull();
  });

  it("renders no refusal where the state carries none", () => {
    expect(renderNotice(STATE_BY_KIND.cut).querySelector(".meridian-refusal")).toBeNull();
  });
});

describe("PartialRead — the console keeps one announcer", () => {
  /**
   * How many regions each arm's tree is entitled to, and whose they are.
   *
   * Every one belongs to a primitive this component MOUNTS — rule 9's refusal region
   * on the three arms that carry a refusal, rule 8's `not-loaded` region on the
   * in-flight arm. The `cut` arm carries neither, and it is the arm that makes the
   * claim checkable: a wrapper of this component's own would show up there as a
   * region with no owner.
   */
  const REGIONS_BY_KIND: Readonly<Record<ReadingStateKind, number>> = {
    served: 0,
    reading: 1,
    refused: 1,
    stale: 1,
    partial: 1,
    cut: 0,
    unchecked: 1,
  };

  it("creates no live region of its own on any arm", () => {
    // `LiveAnnouncerProvider` states the absolute this holds to: one announcer per
    // window, and no other component making a region. A wrapper here was a second
    // region announcing the same sentence, nested inside the refusal's own — which
    // is announced by both, and which mounts with its content already in it, the
    // shape screen readers do not reliably announce at all.
    for (const kind of READING_STATE_KINDS) {
      const container = renderNotice(STATE_BY_KIND[kind]);
      expect(liveRegions(container).length, `${kind} regions`).toBe(REGIONS_BY_KIND[kind]);
    }
  });

  it("leaves the regions it does mount with the primitive that owns them", () => {
    // Not merely "one region" but "the refusal's region": a wrapper that took rule
    // 9's region away and put its own around it would also count one.
    const refusalRegion = liveRegions(renderNotice(STATE_BY_KIND.partial))[0];
    expect(refusalRegion?.classList.contains("meridian-refusal")).toBe(true);
    const absenceRegion = liveRegions(renderNotice(STATE_BY_KIND.reading))[0];
    expect(absenceRegion?.classList.contains("meridian-nothing")).toBe(true);
  });

  it("writes the aria-live attribute nowhere", () => {
    // The absolute as written: the provider's pair are the only `aria-live` nodes in
    // the console, and they are the only ones carrying `aria-atomic` with it.
    for (const kind of READING_STATE_KINDS) {
      const container = renderNotice(STATE_BY_KIND[kind]);
      expect(container.querySelectorAll("[aria-live]").length, `${kind}`).toBe(0);
    }
  });

  it("negative control: the region scan finds the regions that are there", () => {
    // Without this the counts above would also be satisfied by a query that matched
    // nothing, which would make every arm look clean including a wrapper-bearing one.
    expect(liveRegions(renderNotice(STATE_BY_KIND.reading)).length).toBe(1);
    expect(REGIONS_BY_KIND.cut).toBeLessThan(REGIONS_BY_KIND.partial);
  });
});
