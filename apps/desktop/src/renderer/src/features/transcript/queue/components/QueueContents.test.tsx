// The queue's rows, drawn from a feed the case builds by hand: no bridge, no subscription.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { QueueFeed } from "../reading.js";
import { QueueContents } from "./QueueContents.js";
import { queueRow } from "../feed.test-support.js";

function readFeed(items: QueueFeed["items"]): QueueFeed {
  return {
    items,
    phase: "read",
    readRefusal: undefined,
    pendingCancelIds: new Set(),
    cancelItem: () => Promise.resolve(),
  };
}

/** The daemon's order: the admitted head first, then the two rows still waiting. */
const THREE_ROWS: QueueFeed["items"] = [
  queueRow("3f1c9a52-7e64-4b0d-9a13-5c8e2d7b6f01", "admitted", "2026-09-02T09:00:00.000Z"),
  queueRow("8a4d2e61-15b3-4c79-8e20-1f9b7c3a5d02", "queued", "2026-09-02T09:00:00.000Z"),
  queueRow("c2b7f930-6d48-4e15-b7a4-9e0d1c8f3a03", "queued", "2026-09-02T09:00:00.000Z"),
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
    expect(states).toStrictEqual(["Admitted", "Queued", "Queued"]);
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
});
