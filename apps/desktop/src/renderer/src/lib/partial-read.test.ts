// A view holding two readings can never show one of them as the whole answer.

import { describe, expect, it } from "vitest";

import { partialReadNotices, unreadableDeliveryReading } from "./partial-read.js";

describe("partial-read — a view hands over every reading it holds", () => {
  it("answers a notice per reading that is not the whole of it, even among served ones", () => {
    // A served snapshot beside an unreadable tail must render a notice whichever reading the call
    // site passes.
    const notices = partialReadNotices([
      { kind: "served" },
      { kind: "partial", unreadableCount: 3 },
    ]);
    expect(notices).toStrictEqual([{ figure: "3", copy: "deliveries could not be read." }]);
  });
});

describe("partial-read — the producer shapes", () => {
  it("makes a real unreadable count a partial reading", () => {
    // A constructor answering `served` here would hide deliveries that could not be read.
    expect(unreadableDeliveryReading(2)).toStrictEqual({ kind: "partial", unreadableCount: 2 });
  });
});
