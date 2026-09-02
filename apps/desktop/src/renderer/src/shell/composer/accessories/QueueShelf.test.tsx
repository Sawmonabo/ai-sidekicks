// What the shelf says about a cancel that is already going.
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

import { QueueItemSummarySchema, type QueueItemSummary } from "@ai-sidekicks/contracts";

import { refuse, type ConsoleRefusal } from "../../../console/core/index.js";
import { QueueShelf } from "./QueueShelf.js";

const FIRST_ITEM = "1a2b3c4d-5e6f-4071-8283-94a5b6c7d8e9";
const SECOND_ITEM = "2b3c4d5e-6f70-4182-9394-a5b6c7d8e9f0";

/** One waiting row, through the registered parse every caller of the shelf performs. */
function queuedRow(id: string): QueueItemSummary {
  return QueueItemSummarySchema.parse({
    id,
    state: "queued",
    priority: 0,
    createdAt: "2026-09-02T09:00:00.000Z",
    updatedAt: "2026-09-02T09:00:00.000Z",
  });
}

function shelfWith(options: {
  readonly pendingCancelIds?: ReadonlySet<string>;
  readonly cancelRefusalByItemId?: ReadonlyMap<string, ConsoleRefusal>;
}): readonly HTMLButtonElement[] {
  const { container } = render(
    <QueueShelf
      items={[queuedRow(FIRST_ITEM), queuedRow(SECOND_ITEM)]}
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
