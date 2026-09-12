// The carrier as an ordered list, the grip that moves a row, and the bound each row's
// own size is measured against.
//
// THE KEYBOARD PATH IS THE ONE THIS TIER CAN DRIVE, and it is not a lesser path: the
// adopted drag library publishes no keyboard drag by design and requires the same
// outcome on an ordinary control with an announcement beside it, so what is asserted
// here is a first-class half of the interaction rather than a stand-in for the pointer.
// The pointer half needs a real `DataTransfer` and a real `elementFromPoint`, neither of
// which happy-dom has, so it is driven in the browser tier — see
// `test/console/browser/attachment-carrier-drag.test.tsx`.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "../../core/index.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { CarrierList } from "./CarrierList.js";
import type { AttachmentAllowlistReading } from "./attachment-bounds.js";
import {
  CARRIER_ENTRY_MILLISECONDS,
  carrierEntry,
  threeAttachmentCarrier,
} from "./carrier-entries.test-support.js";
import { type AttachmentIngestEntry } from "./attachment-shapes.js";

/** The per-attachment bound the rows in these cases are measured against. */
const ADMITTED_BYTES = 1_000;

/**
 * The bound as a DEPLOYMENT reported it, and the bound as this console ships it.
 *
 * Two readings rather than one, because the row's copy turns on which of them it was
 * handed — and only one of the two is reachable in the shipped console today, which is
 * exactly why the other has to be pinned here: the affordance renders the shipped
 * default on every build, so a suite that only drove the effective arm would leave the
 * arm a user actually meets undrawn.
 */
const EFFECTIVE_BOUNDS: AttachmentAllowlistReading = {
  source: "effective",
  mediaTypes: ["text/markdown"],
  maximumByteLength: ADMITTED_BYTES,
  refusal: undefined,
};

const SHIPPED_DEFAULT_BOUNDS: AttachmentAllowlistReading = {
  ...EFFECTIVE_BOUNDS,
  source: "shipped-default",
};

interface RenderedList {
  readonly container: HTMLElement;
  readonly grips: readonly HTMLElement[];
  readonly moves: { readonly localId: string; readonly toPosition: number }[];
  readonly announced: () => string;
}

function renderList(
  entries: readonly AttachmentIngestEntry[],
  allowlist: AttachmentAllowlistReading = EFFECTIVE_BOUNDS,
): RenderedList {
  const moves: { readonly localId: string; readonly toPosition: number }[] = [];
  const { container } = render(
    <LiveAnnouncerProvider clock={new ManualClock()}>
      <CarrierList
        entries={entries}
        publishedAtMilliseconds={CARRIER_ENTRY_MILLISECONDS}
        allowlist={allowlist}
        onRetry={() => undefined}
        onAbandon={() => undefined}
        onReorder={(localId, toPosition) => {
          moves.push({ localId, toPosition });
        }}
      />
    </LiveAnnouncerProvider>,
  );
  return {
    container,
    grips: [...container.querySelectorAll<HTMLElement>(".meridian-carrier-row__grip")],
    moves,
    // Both regions, joined: which politeness a move takes is the announcer's rule and
    // not this surface's, so a case asserting the sentence must not also pin the lane.
    announced: () =>
      [...document.querySelectorAll("[aria-live]")].map((region) => region.textContent).join(" "),
  };
}

describe("carrier list — the declared order as an ordered list", () => {
  it("draws one row per attachment, inside a single ordered list", () => {
    const list = renderList([
      carrierEntry("attachment-1", "first.md"),
      carrierEntry("attachment-2", "second.md"),
    ]);
    const ordered = list.container.querySelector("ol.meridian-carrier-list");
    expect(ordered).not.toBeNull();
    expect(ordered?.querySelectorAll(":scope > li.meridian-carrier-row")).toHaveLength(2);
  });

  it("names each grip with the attachment and its position in the list", () => {
    const list = renderList([
      carrierEntry("attachment-1", "first.md"),
      carrierEntry("attachment-2", "second.md"),
    ]);
    expect(list.grips[0]?.getAttribute("aria-label")).toContain("first.md");
    expect(list.grips[0]?.getAttribute("aria-label")).toContain("position 1 of 2");
    expect(list.grips[1]?.getAttribute("aria-label")).toContain("position 2 of 2");
  });

  it("registers each row with the drag adapter", () => {
    // The adopted library marks the element it will drag. Asserting the attribute is
    // what separates "the binding ran" from "a grip was drawn": a row that rendered a
    // handle and never registered would look identical and drag nothing.
    const list = renderList([
      carrierEntry("attachment-1", "first.md"),
      carrierEntry("attachment-2", "second.md"),
    ]);
    const rows = [...list.container.querySelectorAll<HTMLElement>("li.meridian-carrier-row")];
    expect(rows.map((row) => row.getAttribute("draggable"))).toStrictEqual(["true", "true"]);
  });
});

describe("carrier list — moving an attachment from the keyboard", () => {
  it("moves one position later and says so", () => {
    const list = renderList(threeAttachmentCarrier());
    fireEvent.keyDown(list.grips[0] as HTMLElement, { key: "ArrowDown" });
    expect(list.moves).toStrictEqual([{ localId: "attachment-1", toPosition: 1 }]);
    expect(list.announced()).toContain("first.md moved to position 2 of 3.");
  });

  it("moves one position earlier and says so", () => {
    const list = renderList(threeAttachmentCarrier());
    fireEvent.keyDown(list.grips[2] as HTMLElement, { key: "ArrowUp" });
    expect(list.moves).toStrictEqual([{ localId: "attachment-3", toPosition: 1 }]);
    expect(list.announced()).toContain("third.md moved to position 2 of 3.");
  });

  it("negative control: a press at the end of the list moves nothing and says nothing", () => {
    // Without this the handler could clamp, report the position the attachment is
    // already at, and announce a move that did not happen on every press.
    const list = renderList([
      carrierEntry("attachment-1", "first.md"),
      carrierEntry("attachment-2", "second.md"),
    ]);
    fireEvent.keyDown(list.grips[0] as HTMLElement, { key: "ArrowUp" });
    fireEvent.keyDown(list.grips[1] as HTMLElement, { key: "ArrowDown" });
    expect(list.moves).toStrictEqual([]);
    expect(list.announced()).not.toContain("moved to position");
  });

  it("negative control: a key the grip does not answer for moves nothing", () => {
    const list = renderList([
      carrierEntry("attachment-1", "first.md"),
      carrierEntry("attachment-2", "second.md"),
    ]);
    fireEvent.keyDown(list.grips[0] as HTMLElement, { key: "ArrowRight" });
    expect(list.moves).toStrictEqual([]);
  });
});

describe("carrier list — one attachment's size against the bound", () => {
  it("states the declared size and the bound it will be measured by", () => {
    const list = renderList([carrierEntry("attachment-1", "first.md")]);
    const allowance =
      list.container.querySelector(".meridian-carrier-row__allowance")?.textContent ?? "";
    expect(allowance).toContain("300");
    expect(allowance).toContain("this deployment admits per attachment");
  });

  it("says what the size refusal will say, ahead of it, without withdrawing anything", () => {
    const list = renderList([carrierEntry("attachment-1", "huge.md", ADMITTED_BYTES + 1)]);
    const overAllowance = list.container.querySelector(".meridian-carrier-row__over-allowance");
    expect(overAllowance?.getAttribute("role")).toBe("status");
    const warning = overAllowance?.textContent ?? "";
    expect(warning).toContain("reserved the spool");
    // Still one row, still gripped, still sending: the three enforcement points are
    // the daemon's and the console adds no fourth.
    expect(list.container.querySelectorAll("li.meridian-carrier-row")).toHaveLength(1);
    expect(list.grips).toHaveLength(1);
  });

  it("negative control: an attachment inside the bound carries no warning", () => {
    const list = renderList([carrierEntry("attachment-1", "first.md", ADMITTED_BYTES)]);
    expect(list.container.querySelector(".meridian-carrier-row__over-allowance")).toBeNull();
  });
});

describe("carrier list — whose bound the row is measuring against", () => {
  it("qualifies the figure as the shipped default, and says where the real one is settled", () => {
    // The arm every build of the console actually reaches: no registered wire answers
    // the effective allow-list, so the affordance renders what it ships with. Claimed
    // as "this deployment admits", that figure is a statement about a deployment
    // nothing has read.
    const list = renderList([carrierEntry("attachment-1", "first.md")], SHIPPED_DEFAULT_BOUNDS);
    const allowance =
      list.container.querySelector(".meridian-carrier-row__allowance")?.textContent ?? "";
    expect(allowance).toContain("ships as the default per attachment");
    expect(allowance).toContain("settled at ingest");
    // THE `×` LINE, and it is the effective arm's clause verbatim rather than a
    // fragment of it: this arm may — and does — name the deployment, as the place the
    // real bound gets settled. What it must never do is CLAIM the figure beside it is
    // the one that deployment admits, which is the whole of the effective sentence.
    expect(allowance).not.toContain("this deployment admits per attachment");
  });

  it("forecasts the refusal on that arm rather than reporting one, and names all three bounds", () => {
    const list = renderList(
      [carrierEntry("attachment-1", "huge.md", ADMITTED_BYTES + 1)],
      SHIPPED_DEFAULT_BOUNDS,
    );
    const warning =
      list.container.querySelector(".meridian-carrier-row__over-allowance")?.textContent ?? "";
    // The forecast is conditional and future, and it is the refusal's own three bounds
    // rather than a paraphrase — the reservation point among them, which is the one a
    // person never guesses.
    expect(warning).toContain("If this deployment kept the shipped default");
    expect(warning).toContain("reserved the spool");
    expect(warning).toContain("relay publish cap");
    // THE `×` LINE. Before the arm split, this row rendered the refusal's own
    // past-tense report above a file no daemon had been asked about.
    expect(warning).not.toContain("Nothing was stored");
  });

  it("negative control: the effective arm still reports the refusal in its own words", () => {
    // The split must not turn every warning into a forecast: where the daemon DID
    // report the bound, the refusal's own copy is what this row is supposed to carry.
    const list = renderList(
      [carrierEntry("attachment-1", "huge.md", ADMITTED_BYTES + 1)],
      EFFECTIVE_BOUNDS,
    );
    const warning =
      list.container.querySelector(".meridian-carrier-row__over-allowance")?.textContent ?? "";
    expect(warning).toContain("Nothing was stored");
    expect(warning).toContain("reserved the spool");
    expect(warning).not.toContain("If this deployment kept the shipped default");
  });
});
