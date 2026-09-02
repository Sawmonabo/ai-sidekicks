// Which row of a scripted `run.queueList` reply a queue beat is about.
//
// The module answers one question and the failure it guards against is the quiet
// one: a lookup that answered `undefined` for everything would make every queue beat
// refuse, and a lookup that answered the FIRST row for everything would hand one
// queue item another item's `priority` and `createdAt`. Both look like a working
// fixture from the outside, so every clean case below is pinned against a control.
//
// The reply is scenario data typed `unknown`, which is what a scripted reply is, so
// the malformed shapes are not defensive padding — they are what a scenario author
// gets wrong, and each one has to read as "no row" rather than as a crash inside the
// beat loop.

import { describe, expect, it } from "vitest";

import { RUN_QUEUE_ROW_READ, scriptedQueueRowFor } from "./queue-row-source.js";

const FIRST_QUEUE_ITEM_ID = "019b79ee-0280-7c11-8110-d1a4c1150091";
const SECOND_QUEUE_ITEM_ID = "019b79ee-0280-7c11-8110-d1a4c1150092";

/** A `QueueItemListResponse`-shaped reply carrying both rows, in order. */
function queueListReply(): unknown {
  return {
    items: [
      {
        id: FIRST_QUEUE_ITEM_ID,
        state: "queued",
        priority: 0,
        createdAt: "2026-01-01T14:20:00.100Z",
      },
      {
        id: SECOND_QUEUE_ITEM_ID,
        state: "admitted",
        priority: 7,
        createdAt: "2026-01-01T14:20:00.200Z",
      },
    ],
  };
}

describe("queue row source — the row a beat is about", () => {
  it("names the registered read once, so both sides of the seam spell it the same", () => {
    expect(RUN_QUEUE_ROW_READ).toBe("run.queueList");
  });

  it("finds the row by its own id rather than by position", () => {
    const row = scriptedQueueRowFor(queueListReply(), SECOND_QUEUE_ITEM_ID);

    // The SECOND row, so a lookup that answered with the head of the list fails.
    expect(row?.["priority"]).toBe(7);
    expect(row?.["createdAt"]).toBe("2026-01-01T14:20:00.200Z");
  });

  it("negative control: it finds the other row too, by its own id", () => {
    // Without it, a lookup hard-wired to the last entry would pass the case above.
    expect(scriptedQueueRowFor(queueListReply(), FIRST_QUEUE_ITEM_ID)?.["priority"]).toBe(0);
  });

  it("answers with no row for an id the read does not carry", () => {
    expect(scriptedQueueRowFor(queueListReply(), "019b79ee-0280-7c11-8110-d1a4c1150099")).toBe(
      undefined,
    );
  });
});

describe("queue row source — a read that is not one", () => {
  it("answers with no row rather than throwing, for every shape a scenario can script", () => {
    // `undefined` is the shape that matters most: it is what an UNSCRIPTED read
    // resolves to, which is the common case and the one the projection turns into a
    // refusal naming the read.
    for (const scriptedReadResult of [
      undefined,
      null,
      "run.queueList",
      42,
      [],
      {},
      { items: undefined },
      { items: "one row" },
      { items: [null, "row", 7] },
    ]) {
      expect(scriptedQueueRowFor(scriptedReadResult, FIRST_QUEUE_ITEM_ID)).toBe(undefined);
    }
  });

  it("negative control: a well-formed reply carrying the id does answer", () => {
    // Without it, a reader that returned `undefined` unconditionally would satisfy
    // every case above — and every queue beat in every scenario would refuse.
    expect(scriptedQueueRowFor(queueListReply(), FIRST_QUEUE_ITEM_ID)).toBeDefined();
  });
});
