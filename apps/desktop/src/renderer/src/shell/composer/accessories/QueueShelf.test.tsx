// What the shelf says about a cancel that is already going.
//
// The partial-read arm is here for the same reason: the runs pane says a delivery
// could not be read, and a shelf over the same reading that stayed silent would let
// a person read the composer's own queue as complete while the pane beside it said
// otherwise.
//
// The shelf and the runs pane's queue are two surfaces over ONE reading, so the
// claim worth a unit is that they agree: the row whose id the reading reports as
// pending is disabled and `aria-busy`, and every other row stays live. The
// authoritative single-flight is the reading's own chokepoint — asserted where it
// lives, in `console/bridge/queue-feed.test.tsx` — and what is asserted here is that
// a person can see it, because a control that stays live while its mutation is in
// flight invites the second press the chokepoint then swallows silently.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { QueueItemSummary } from "@ai-sidekicks/contracts";

import { refuse, type ConsoleRefusal } from "../../../console/core/index.js";
import { QueueShelf } from "./QueueShelf.js";
import { fixtureQueueItemId, queueRow } from "./queue-rows.test-support.js";

const FIRST_ITEM = fixtureQueueItemId("1a2b3c4d-5e6f-4071-8283-94a5b6c7d8e9");
const SECOND_ITEM = fixtureQueueItemId("2b3c4d5e-6f70-4182-9394-a5b6c7d8e9f0");

/** One waiting row, through the zone's own builder over the registered shape. */
function queuedRow(id: QueueItemSummary["id"]): QueueItemSummary {
  return queueRow(id, "queued");
}

function shelfWith(options: {
  readonly pendingCancelIds?: ReadonlySet<string>;
  readonly cancelRefusalByItemId?: ReadonlyMap<string, ConsoleRefusal>;
}): readonly HTMLButtonElement[] {
  const { container } = render(
    <QueueShelf
      items={[queuedRow(FIRST_ITEM), queuedRow(SECOND_ITEM)]}
      phase="read"
      readRefusal={undefined}
      pendingCancelIds={options.pendingCancelIds ?? new Set<string>()}
      cancelRefusalByItemId={options.cancelRefusalByItemId ?? new Map<string, ConsoleRefusal>()}
      onCancel={() => undefined}
    />,
  );
  const buttons = [...container.querySelectorAll(".meridian-queue-shelf__cancel")];
  return buttons.filter(
    (button): button is HTMLButtonElement => button instanceof HTMLButtonElement,
  );
}

describe("the queue shelf renders the cancel that is already going", () => {
  it("disables the pending row's control and leaves the other live", () => {
    const [first, second] = shelfWith({ pendingCancelIds: new Set([FIRST_ITEM]) });
    expect(first?.disabled).toBe(true);
    expect(first?.getAttribute("aria-busy")).toBe("true");
    expect(second?.disabled).toBe(false);
  });

  it("negative control: with nothing pending every control is live", () => {
    // The shipped shelf took no pending set at all, so every row rendered exactly
    // like this one whatever the reading said — which is the case above failing.
    const [first, second] = shelfWith({});
    expect(first?.disabled).toBe(false);
    expect(second?.disabled).toBe(false);
    expect(first?.getAttribute("aria-busy")).toBe("false");
  });

  it("leaves the other rows live when one row's cancel was refused", () => {
    const [first, second] = shelfWith({
      cancelRefusalByItemId: new Map([
        [
          FIRST_ITEM,
          refuse("session-queue", "queue.item_not_cancelable", "It had left the queue."),
        ],
      ]),
    });
    expect(first?.disabled).toBe(false);
    expect(second?.disabled).toBe(false);
  });
});

describe("the queue shelf says when part of its stream could not be read", () => {
  /** The shelf with whatever partial reading the case supplies. */
  function renderShelf(options: {
    readonly items?: readonly QueueItemSummary[];
    readonly unreadableDeliveryCount?: number;
    readonly unreadableRefusal?: ConsoleRefusal;
  }): HTMLElement {
    const { container } = render(
      <QueueShelf
        items={options.items ?? [queuedRow(FIRST_ITEM)]}
        phase="read"
        readRefusal={undefined}
        pendingCancelIds={new Set<string>()}
        cancelRefusalByItemId={new Map<string, ConsoleRefusal>()}
        onCancel={() => undefined}
        unreadableDeliveryCount={options.unreadableDeliveryCount}
        unreadableRefusal={options.unreadableRefusal}
      />,
    );
    return container;
  }

  it("keeps the rows and names how many deliveries could not be read", () => {
    // The finding this answers: a delivery the build could not read changes no row,
    // so a shelf that showed only rows presented a stale list as a current one.
    const container = renderShelf({ unreadableDeliveryCount: 2 });

    expect(container.querySelector(".meridian-partial-read__copy")?.textContent).toContain(
      "2 deliveries could not be read, so the queue may be behind what the daemon has sent.",
    );
    expect(container.querySelectorAll(".meridian-queue-shelf__row")).toHaveLength(1);
  });

  it("appears with no rows at all, because an empty list is not known to be empty", () => {
    // The shelf hides itself when nothing is waiting. That rule assumes the emptiness
    // is READ, and an unreadable delivery is exactly the case where it is not — so
    // the hidden arm would have hidden the only statement that a row may be missing.
    const container = renderShelf({ items: [], unreadableDeliveryCount: 1 });

    expect(container.querySelector(".meridian-queue-shelf")).not.toBeNull();
    expect(container.querySelector(".meridian-partial-read__copy")?.textContent).toContain(
      "1 delivery could not be read",
    );
  });

  it("renders the delivery's own parse refusal beside the count", () => {
    const container = renderShelf({
      unreadableDeliveryCount: 1,
      unreadableRefusal: refuse(
        "session-queue",
        "delivery-unreadable",
        "A queue delivery did not match the registered row shape.",
      ),
    });

    expect(container.querySelector(".meridian-refusal")?.textContent).toContain(
      "delivery-unreadable",
    );
  });

  it("negative control: a complete reading says none of it", () => {
    const withRows = renderShelf({ unreadableDeliveryCount: 0 });
    expect(withRows.querySelector(".meridian-partial-read")).toBeNull();

    const withNothing = renderShelf({ items: [], unreadableDeliveryCount: 0 });
    expect(withNothing.querySelector(".meridian-queue-shelf")).toBeNull();
  });

  it("hides itself for a count the shared reading calls complete, saying nothing twice", () => {
    // Whether the shelf DRAWS and what it then SAYS about completeness were two
    // rules: a local `count > 0` here and `unreadableDeliveryReading` in the notice.
    // They agree on every whole number above zero and disagree everywhere else — a
    // count of 1.5 is not a number of deliveries, so the shared reading calls it
    // complete while `> 0` called it partial. The shelf drew itself with no rows and
    // no notice beneath: a section about a queue with nothing in it to read.
    const container = renderShelf({ items: [], unreadableDeliveryCount: 1.5 });

    expect(container.querySelector(".meridian-queue-shelf")).toBeNull();
  });
});

describe("the queue shelf says when the snapshot itself could not be read", () => {
  /** The refusal `run.queueList` settles as, in the shape the reading publishes. */
  const READ_REFUSAL: ConsoleRefusal = refuse(
    "session-queue",
    "reply-unreadable",
    "The queue reply did not match the registered list shape, so the console did not read rows from it.",
  );

  /** The shelf under whatever snapshot phase and rows the case supplies. */
  function renderShelf(options: {
    readonly items?: readonly QueueItemSummary[];
    readonly phase: "reading" | "read" | "refused";
    readonly readRefusal?: ConsoleRefusal;
  }): HTMLElement {
    const { container } = render(
      <QueueShelf
        items={options.items ?? []}
        phase={options.phase}
        readRefusal={options.readRefusal}
        pendingCancelIds={new Set<string>()}
        cancelRefusalByItemId={new Map<string, ConsoleRefusal>()}
        onCancel={() => undefined}
      />,
    );
    return container;
  }

  it("appears with no rows at all, rather than reading as an empty queue", () => {
    // The finding: the rail passed rows and nothing else, so a refused snapshot with
    // an empty tail hid the shelf — which is the surface saying "nothing is queued"
    // about a list nobody managed to read.
    const container = renderShelf({ phase: "refused", readRefusal: READ_REFUSAL });

    expect(container.querySelector(".meridian-queue-shelf")).not.toBeNull();
    expect(container.querySelector(".meridian-partial-read__copy")?.textContent).toContain(
      "The read of the queue was refused, so what is shown here is not the whole of it.",
    );
    expect(container.querySelector(".meridian-refusal")?.textContent).toContain("reply-unreadable");
  });

  it("keeps the tail's rows and says they are not the whole queue", () => {
    // The other half: the tail opens before the snapshot, so a refused read can
    // leave a subset on screen — which without this reads as the complete list.
    const container = renderShelf({
      items: [queuedRow(FIRST_ITEM)],
      phase: "refused",
      readRefusal: READ_REFUSAL,
    });

    expect(container.querySelectorAll(".meridian-queue-shelf__row")).toHaveLength(1);
    expect(container.querySelector(".meridian-partial-read__copy")?.textContent).toContain(
      "is not the whole of it",
    );
  });

  it("says nothing the read did not carry when the refusal is absent", () => {
    // The reading publishes the phase and the refusal separately, so the notice
    // renders on the phase alone and invents no cause where none was carried. The
    // shelf reaches for the one reading kind that withdraws the completeness claim
    // and carries no refusal — never a sentence with a code this console made up.
    const container = renderShelf({ phase: "refused" });

    expect(container.querySelector(".meridian-partial-read__copy")).not.toBeNull();
    expect(container.querySelector(".meridian-refusal")).toBeNull();
  });

  it("negative control: a served empty read still hides the shelf", () => {
    // Without this the cases above would hold over a shelf that had simply stopped
    // hiding itself — and the hidden-until-an-item-exists rule is what keeps the
    // ordinary case quiet.
    expect(renderShelf({ phase: "read" }).querySelector(".meridian-queue-shelf")).toBeNull();
    expect(renderShelf({ phase: "reading" }).querySelector(".meridian-queue-shelf")).toBeNull();
  });
});
