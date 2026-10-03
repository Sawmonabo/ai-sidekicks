// A view holding two readings can never show one of them as the whole answer.

import { describe, expect, it } from "vitest";

import { refuse } from "./refusal.js";
import { partialReadNotices, unreadableDeliveryReading } from "./partial-read.js";

const PARSE_REFUSAL = refuse(
  "session-queue",
  "delivery-unreadable",
  "A queue delivery did not match the registered row shape.",
);

describe("partial-read — a view hands over every reading it holds", () => {
  it("answers a notice per reading that is not the whole of it, even among served ones", () => {
    // A served snapshot beside an unreadable tail must render a notice whichever reading the call
    // site passes.
    const notices = partialReadNotices(
      [
        { kind: "served" },
        { kind: "partial", unreadableCount: 3, newestRefusal: PARSE_REFUSAL },
        { kind: "cut", servedCount: 12 },
      ],
      "the queue",
    );
    expect(notices.length).toBe(2);
    expect(notices.every((notice) => notice.shape !== "none")).toBe(true);
  });
});

describe("partial-read — the producer shapes", () => {
  it("makes a real unreadable count a partial reading that keeps its refusal", () => {
    // A constructor answering `served` here would hide deliveries that could not be read.
    expect(unreadableDeliveryReading(2, PARSE_REFUSAL)).toStrictEqual({
      kind: "partial",
      unreadableCount: 2,
      newestRefusal: PARSE_REFUSAL,
    });
  });
});
