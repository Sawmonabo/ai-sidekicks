// The queue's rows, drawn from a feed the case builds by hand: no bridge, no subscription.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { readQueueItemId } from "@renderer/services/daemon/wire-identifiers.js";
import type { QueueItemSummary } from "@ai-sidekicks/contracts";

import type { QueueFeed } from "../queue-reading.js";
import { QueueContents } from "./QueueContents.js";

function queueItem(rawId: string, state: QueueItemSummary["state"]): QueueItemSummary {
  const id = readQueueItemId(rawId);
  if (id === undefined) {
    throw new Error("the queue-row fixture names an item identifier the wire refuses");
  }
  return {
    id,
    state,
    priority: 0,
    content: "Also run the linter",
    createdAt: "2026-09-02T09:00:00.000Z",
    updatedAt: "2026-09-02T09:00:00.000Z",
  };
}

function readFeed(items: QueueFeed["items"]): QueueFeed {
  return {
    items,
    phase: "read",
    pendingCancelIds: new Set(),
    cancelItem: () => Promise.resolve(),
  };
}

/** The daemon's order: the admitted head first, then the two rows still waiting. */
const THREE_ROWS: QueueFeed["items"] = [
  queueItem("3f1c9a52-7e64-4b0d-9a13-5c8e2d7b6f01", "admitted"),
  queueItem("8a4d2e61-15b3-4c79-8e20-1f9b7c3a5d02", "queued"),
  queueItem("c2b7f930-6d48-4e15-b7a4-9e0d1c8f3a03", "queued"),
];

function renderQueue(): HTMLElement {
  return render(<QueueContents feed={readFeed(THREE_ROWS)} />).container;
}

describe("the queue renders the rows it is given", () => {
  it("draws one row per item, in the daemon's order", () => {
    const container = renderQueue();
    const states = [...container.querySelectorAll(".meridian-queue__identity .meridian-chip")].map(
      (chip) => chip.textContent,
    );
    // The feed's canonical FIFO order, unreordered: the admitted head first.
    expect(states).toStrictEqual(["admitted", "queued", "queued"]);
  });

  it("keeps a row that is no longer waiting rather than dropping it", () => {
    // A queue row is durable and never deleted, so the `admitted` row is still a row.
    const container = renderQueue();
    expect(container.textContent).toContain("admitted");
  });

  it("negative control: the empty state is not what rendered", () => {
    // Guards against a component that rendered its empty state and happened to contain "queued".
    const container = renderQueue();
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
    expect(container.querySelectorAll(".meridian-queue__row")).toHaveLength(3);
  });
});

describe("cancel before admission", () => {
  it("offers cancel on exactly the rows that are still waiting", () => {
    const container = renderQueue();
    const rows = [...container.querySelectorAll(".meridian-queue__row")];
    const cancelable = rows.map((row) => row.querySelector(".meridian-queue__cancel") !== null);
    // The `admitted` head cannot be taken back; the two `queued` rows can.
    expect(cancelable).toStrictEqual([false, true, true]);
  });

  it("negative control: the control is a real button, not decoration", () => {
    const container = renderQueue();
    const cancel = container.querySelector(".meridian-queue__cancel");
    expect(cancel).toBeInstanceOf(HTMLButtonElement);
    expect((cancel as HTMLButtonElement).disabled).toBe(false);
  });
});
