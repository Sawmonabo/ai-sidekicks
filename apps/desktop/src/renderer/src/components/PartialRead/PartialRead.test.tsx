// The notices rendered, and the one thing they must never do: create a live region of their own.
// A set of served readings renders nothing, every other state renders something visible, and the
// cause reaches the screen through the refusal primitive.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PartialRead } from "./PartialRead.js";
import {
  READING_STATE_KINDS,
  type ReadingState,
  type ReadingStateKind,
} from "@renderer/lib/partial-read.js";
import { PARSE_REFUSAL, READING_SUBJECT, STATE_BY_KIND } from "@test/helpers/partial-read.js";

/** Every element that is a live region, however it is spelled. */
function liveRegions(container: HTMLElement): readonly Element[] {
  return [...container.querySelectorAll('[role="status"], [role="alert"], [aria-live]')];
}

function renderNotice(...states: readonly ReadingState[]): HTMLElement {
  const { container } = render(<PartialRead states={states} subject={READING_SUBJECT} />);
  return container;
}

describe("PartialRead — a view says less than complete, never more", () => {
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

  it("mounts one notice per reading a view holds", () => {
    // A served snapshot beside an unreadable tail is one notice; two incomplete readings are two.
    const container = renderNotice(
      { kind: "served" },
      STATE_BY_KIND.partial,
      STATE_BY_KIND.refused,
    );
    expect(container.querySelectorAll(".meridian-partial-read").length).toBe(2);
  });

  it("negative control: the emptiness check reads the real tree", () => {
    // Negative control: `innerHTML` would be empty for a container never rendered into.
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
    // The console counted these, so the count is derived, not wire; the refusal beneath is wire,
    // so the assertion is scoped to the copy line.
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
   * How many live regions each arm is entitled to. All belong to mounted primitives (the
   * refusal's, or the `not-loaded` absence's); `cut` has none, so an own wrapper would show there.
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
    // One announcer per window: a wrapper here would announce the same sentence twice, mounted
    // with its content already in it.
    for (const kind of READING_STATE_KINDS) {
      const container = renderNotice(STATE_BY_KIND[kind]);
      expect(liveRegions(container).length, `${kind} regions`).toBe(REGIONS_BY_KIND[kind]);
    }
  });

  it("leaves the regions it does mount with the primitive that owns them", () => {
    // Not merely one region but the refusal's: a wrapper replacing it would also count one.
    const refusalRegion = liveRegions(renderNotice(STATE_BY_KIND.partial))[0];
    expect(refusalRegion?.classList.contains("meridian-refusal")).toBe(true);
    const absenceRegion = liveRegions(renderNotice(STATE_BY_KIND.reading))[0];
    expect(absenceRegion?.classList.contains("meridian-nothing")).toBe(true);
  });

  it("writes the aria-live attribute nowhere", () => {
    // The provider's pair are the only `aria-live` nodes in the console.
    for (const kind of READING_STATE_KINDS) {
      const container = renderNotice(STATE_BY_KIND[kind]);
      expect(container.querySelectorAll("[aria-live]").length, `${kind}`).toBe(0);
    }
  });

  it("negative control: the region scan finds the regions that are there", () => {
    // Negative control: a query matching nothing would make every arm look clean.
    expect(liveRegions(renderNotice(STATE_BY_KIND.reading)).length).toBe(1);
    expect(REGIONS_BY_KIND.cut).toBeLessThan(REGIONS_BY_KIND.partial);
  });
});
