// The queue, rendered from the scenario the fixture bridge actually serves.
//
// The point of driving this through `createFixtureBridge` rather than through a
// hand-built feed is that the scenario is what a person sees when they open the
// runs surface in the fixture: if the scripted `run.queueList` reply stops parsing
// through the registered schema, this file fails rather than the pane quietly
// rendering an empty queue.

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, readQueueItemId, type ConsoleBridge } from "../../../bridge/index.js";
import { settleScheduledRead } from "../../../bridge/scheduled-read.test-support.js";
import type { QueueItemSummary } from "@ai-sidekicks/contracts";

import type { QueueFeed } from "../../../bridge/index.js";
import { RUNS_SCENARIO } from "../../../bridge/scenarios/runs.js";
import { refuse } from "../../../core/index.js";
import { QueueContents } from "./QueueContents.js";
import { useQueueFeed } from "../../../bridge/index.js";

/** A one-component harness: the real hook, the real component, the real fixture. */
function QueueHarness(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
}): React.JSX.Element {
  const feed = useQueueFeed(props.bridge, props.sessionId);
  return <QueueContents feed={feed} />;
}

async function renderQueue(): Promise<HTMLElement> {
  // Built once and OUTSIDE the component. A fresh bridge per render would change the
  // hook's dependency on every pass and re-open the subscription forever, which is a
  // defect in the harness rather than in the feed — and one worth stating, because
  // the symptom (a queue that never settles) looks exactly like a wire fault. It is
  // built here rather than in a memo because the case has to reach the frozen clock
  // this bridge carries: the snapshot read is scheduled against it, so a harness that
  // kept the bridge to itself could never let that read happen.
  const bridge = createFixtureBridge({ scenario: RUNS_SCENARIO });
  const { container } = render(
    <QueueHarness bridge={bridge} sessionId={RUNS_SCENARIO.sessionId} />,
  );
  await settleScheduledRead(bridge);
  await waitFor(() => {
    expect(container.querySelector(".meridian-queue__row")).not.toBeNull();
  });
  return container;
}

describe("the queue renders from scenario data", () => {
  it("draws one row per scripted item, in the daemon's order", async () => {
    const container = await renderQueue();
    const states = [...container.querySelectorAll(".meridian-queue__identity .meridian-chip")].map(
      (chip) => chip.textContent,
    );
    // The scenario's canonical FIFO order, unreordered: the admitted head first.
    expect(states).toStrictEqual(["admitted", "queued", "queued"]);
  });

  it("keeps a row that is no longer waiting rather than dropping it", async () => {
    // A queue row is durable and never-evented — drained but never deleted — so the
    // `admitted` row is a row here, unlike on the composer's shelf.
    const container = await renderQueue();
    expect(container.textContent).toContain("admitted");
  });

  it("negative control: the empty state is not what rendered", async () => {
    // Without this the assertions above would pass over a component that rendered
    // its empty state and happened to contain the word "queued" in the copy.
    const container = await renderQueue();
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
    expect(container.querySelectorAll(".meridian-queue__row")).toHaveLength(3);
  });
});

describe("cancel before admission", () => {
  it("offers cancel on exactly the rows that are still waiting", async () => {
    const container = await renderQueue();
    const rows = [...container.querySelectorAll(".meridian-queue__row")];
    const cancellable = rows.map((row) => row.querySelector(".meridian-queue__cancel") !== null);
    // The `admitted` head cannot be taken back; the two `queued` rows can.
    expect(cancellable).toStrictEqual([false, true, true]);
  });

  it("negative control: the control is a real button, not decoration", async () => {
    const container = await renderQueue();
    const cancel = container.querySelector(".meridian-queue__cancel");
    expect(cancel).toBeInstanceOf(HTMLButtonElement);
    expect((cancel as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("a partial reading is said beside the rows, never in place of them", () => {
  /** A reading whose tail carried a delivery this build could not read. */
  function partialFeed(items: QueueFeed["items"]): QueueFeed {
    return {
      items,
      phase: "read",
      readRefusal: undefined,
      pendingCancelIds: new Set(),
      cancelRefusalByItemId: new Map(),
      cancelItem: () => undefined,
      unreadableDeliveryCount: 2,
      unreadableRefusal: refuse(
        "session-queue",
        "delivery-unreadable",
        "A queue delivery did not match the registered row shape, so it changed no row here: state.",
      ),
    };
  }

  const READ_ROW_ID = readQueueItemId("7c6b5a49-3827-4615-9403-2e1d0c9b8a77");
  if (READ_ROW_ID === undefined) {
    throw new Error("the queue-row fixture names an item identifier the wire refuses");
  }

  /** One row of the registered shape, so the list has something to be behind on. */
  const READ_ROW: QueueItemSummary = {
    id: READ_ROW_ID,
    state: "queued",
    priority: 0,
    createdAt: "2026-09-02T09:00:00.000Z",
    updatedAt: "2026-09-02T09:00:00.000Z",
  };

  it("keeps the rows and names how many deliveries could not be read", () => {
    const { container } = render(<QueueContents feed={partialFeed([READ_ROW])} />);
    expect(container.querySelectorAll(".meridian-queue__row")).toHaveLength(1);
    expect(container.querySelector(".meridian-partial-read")?.textContent).toContain(
      "2 deliveries could not be read",
    );
    expect(container.textContent).toContain("may be behind what the daemon has sent");
    // The delivery's own refusal, verbatim beneath the count.
    expect(container.textContent).toContain("delivery-unreadable");
  });

  it("refuses the reassuring empty state while a delivery is unread", () => {
    // An empty list and an unreadable delivery are both true at once, and "nothing
    // is waiting" is the claim that cannot be made from here.
    const { container } = render(<QueueContents feed={partialFeed([])} />);
    expect(container.querySelector(".meridian-partial-read")).not.toBeNull();
    expect(container.textContent).not.toContain("Nothing is waiting.");
  });

  it("negative control: a fully readable reading says nothing about being behind", () => {
    // Without this the cases above would pass over a surface that warned on every
    // reading, and the empty state would be unreachable.
    const { container } = render(
      <QueueContents feed={{ ...partialFeed([]), unreadableDeliveryCount: 0 }} />,
    );
    expect(container.querySelector(".meridian-partial-read")).toBeNull();
    expect(container.textContent).toContain("Nothing is waiting.");
  });
});
