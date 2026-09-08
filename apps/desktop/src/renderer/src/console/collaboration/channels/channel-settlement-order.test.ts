// The ordering itself, asked directly rather than through a row on screen.
//
// `ChannelList.receipt.test.tsx` drives this order the way a person does — press, read,
// press again — and it drives ONE channel, because that is the collision the defect
// happened in. What that leaves unsaid is the half the key exists for: a receipt orders
// the row it names and orders nothing about the row beside it, so one reply is refused
// for the channel that moved and taken for every channel that did not. An order keyed on
// anything coarser than the channel passes every case in that file and drops rows here.
//
// The predicate is asked only about a channel a receipt has already named — the overlay
// map it serves is keyed by exactly those — so that is the domain every case below sits
// in, and a read issued before a channel's first receipt is in it too.

import { describe, expect, it } from "vitest";

import { ChannelSettlementOrder } from "./channel-settlement-order.js";

const REVIEW = "channel-review";
const RELAY = "channel-relay";

describe("channel settlement order", () => {
  it("puts a read issued after a settlement ahead of it", () => {
    const order = new ChannelSettlementOrder();
    order.noteSettled(REVIEW);

    expect(order.openRead().postdatesSettlementFor(REVIEW)).toBe(true);
  });

  it("leaves a read issued before a channel's first settlement behind it", () => {
    const order = new ChannelSettlementOrder();
    // Issued while the row was untouched, and answered after the daemon had moved it —
    // the in-flight read the whole mechanism exists to keep from winning, and the first
    // move on a row, where the order has no register for that channel yet.
    const readIssuedFirst = order.openRead();
    order.noteSettled(REVIEW);

    expect(readIssuedFirst.postdatesSettlementFor(REVIEW)).toBe(false);
  });

  it("orders nothing about the row a receipt did not name", () => {
    const order = new ChannelSettlementOrder();
    order.noteSettled(RELAY);
    // Issued after the relay's move and before the review's: one read, and the answer has
    // to differ per row, because it carries a stale review and a current relay.
    const readIssuedBetween = order.openRead();
    order.noteSettled(REVIEW);

    expect(readIssuedBetween.postdatesSettlementFor(REVIEW)).toBe(false);
    expect(readIssuedBetween.postdatesSettlementFor(RELAY)).toBe(true);
  });
});
