// A shelf row says which run it is bound to, and the shelf says when it could not
// find out.
//
// The composer's half of one claim the runs pane makes too: an edit-and-resend
// originated row is bound to the run it will resume, and a row that is not bound is
// not the same thing as a row nobody asked about. The FOLD that puts the binding on
// the reading is proved once, over the real fixture, in the runs pane's own suite;
// what is proved here is that this surface renders what the fold hands it, since the
// two surfaces share the reading and could still disagree about drawing it.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { QueueItemSummary } from "@ai-sidekicks/contracts";

import type { QueueRunBindingState } from "../../../../console/bridge/index.js";
import { refuse, type ConsoleRefusal } from "../../../../console/core/index.js";
import { QueueShelf } from "./QueueShelf.js";
import { NO_RUN_BINDINGS, fixtureQueueItemId, queueRow } from "./queue-rows.test-support.js";

const BOUND_ITEM = fixtureQueueItemId("3c4d5e6f-7081-4293-84a5-b6c7d8e9f001");
const UNBOUND_ITEM = fixtureQueueItemId("4d5e6f70-8192-43a4-95b6-c7d8e9f00112");
const TARGET_RUN = "019b7a22-2200-7a10-8110-cca011700001";

/** Both rows waiting, so the shelf's own predicate keeps them on screen. */
function waitingRows(): readonly QueueItemSummary[] {
  return [queueRow(BOUND_ITEM, "queued"), queueRow(UNBOUND_ITEM, "queued")];
}

/** The shelf over whatever binding reading the case supplies. */
function renderShelf(runBindings: QueueRunBindingState): HTMLElement {
  const { container } = render(
    <QueueShelf
      items={waitingRows()}
      snapshotRead={{ phase: "read", readRefusal: undefined }}
      runBindings={runBindings}
      pendingCancelIds={new Set<string>()}
      cancelRefusalByItemId={new Map<string, ConsoleRefusal>()}
      onCancel={() => undefined}
    />,
  );
  return container;
}

/** The target each row draws, `undefined` for a row that draws none. */
function targetsDrawn(container: HTMLElement): readonly (string | undefined)[] {
  return [...container.querySelectorAll(".meridian-queue-shelf__row")].map(
    (row) =>
      row.querySelector(".meridian-queue-shelf__run .meridian-figure--wire")?.textContent ??
      undefined,
  );
}

describe("a queue-shelf row says which run it is bound to", () => {
  it("draws the target on the bound row and nothing on the unbound one", () => {
    const container = renderShelf({
      targetRunIdByItemId: new Map([[BOUND_ITEM, TARGET_RUN]]),
      bindingRefusal: undefined,
    });

    // The row the read named nothing about is UNBOUND and draws no target — the
    // durable column's nullable arm, not an absence this surface invented.
    expect(targetsDrawn(container)).toStrictEqual([TARGET_RUN, undefined]);
    // And the slot is named for a reader who cannot see the row's own layout.
    expect(container.querySelector(".meridian-queue-shelf__run")?.textContent).toContain(
      "Bound to run",
    );
  });

  it("carries the whole run id even where the slot clamps it", () => {
    // The value is a wire figure and renders verbatim; the one-line density comes
    // from the slot's own clamp, so the untruncated id has to be reachable — in the
    // DOM and on the row's tooltip — or the clamp would have become a formatter.
    const container = renderShelf({
      targetRunIdByItemId: new Map([[BOUND_ITEM, TARGET_RUN]]),
      bindingRefusal: undefined,
    });

    const slot = container.querySelector(".meridian-queue-shelf__run");
    expect(slot?.getAttribute("title")).toBe(TARGET_RUN);
    expect(slot?.querySelector(".meridian-figure--wire")?.textContent).toBe(TARGET_RUN);
  });

  it("says the binding read refused rather than leaving the rows silently unbound", () => {
    // The arm a release build takes: no wire carries the binding, so the read refuses
    // and every row is targetless. Without the notice that reads as "nothing here is
    // bound to a run", which is a claim about the queue nobody checked.
    const container = renderShelf({
      targetRunIdByItemId: new Map<string, string>(),
      bindingRefusal: refuse(
        "queue-run-binding",
        "wire-unregistered",
        "Not checked — the run each queued item is bound to is not registered on this build yet.",
      ),
    });

    expect(container.querySelector(".meridian-refusal")?.textContent).toContain(
      "wire-unregistered",
    );
    expect(container.querySelectorAll(".meridian-queue-shelf__row")).toHaveLength(2);
    expect(targetsDrawn(container)).toStrictEqual([undefined, undefined]);
  });

  it("negative control: a served read naming none draws no target and no refusal", () => {
    // Without this the two cases above would hold over a shelf that drew a target
    // unconditionally, or one that mounted the notice whenever a row was unbound —
    // and "the read found no binding for this row" is not a refusal.
    const container = renderShelf(NO_RUN_BINDINGS);

    expect(container.querySelector(".meridian-refusal")).toBeNull();
    expect(targetsDrawn(container)).toStrictEqual([undefined, undefined]);
  });
});
