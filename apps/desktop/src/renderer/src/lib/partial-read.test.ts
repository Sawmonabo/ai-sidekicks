// A state that is not `served` never renders as complete, and a view holding two readings can
// never show one of them. The set is driven from `READING_STATE_KINDS`, so a state that falls
// through to the "no notice" shape fails here.

import { describe, expect, it } from "vitest";

import {
  READING_STATE_KINDS,
  partialReadNotices,
  readingNoticeFor,
  unreadableDeliveryReading,
} from "./partial-read.js";
import { PARSE_REFUSAL, READING_SUBJECT, STATE_BY_KIND } from "@test/helpers/partial-read.js";

describe("partial-read — completeness is claimed by exactly one state", () => {
  it("renders no notice for a served reading and a notice for every other kind", () => {
    const claimingCompleteness = READING_STATE_KINDS.filter(
      (kind) => readingNoticeFor(STATE_BY_KIND[kind], READING_SUBJECT).shape === "none",
    );
    expect(claimingCompleteness).toStrictEqual(["served"]);
  });
});

describe("partial-read — a view hands over every reading it holds", () => {
  it("answers a notice per reading that is not the whole of it, even among served ones", () => {
    // A served snapshot beside an unreadable tail must render a notice whichever reading the call
    // site passes.
    const notices = partialReadNotices(
      [{ kind: "served" }, STATE_BY_KIND.partial, STATE_BY_KIND.cut],
      READING_SUBJECT,
    );
    expect(notices.length).toBe(2);
    expect(notices.every((notice) => notice.shape !== "none")).toBe(true);
    // One incomplete reading between served ones still speaks.
    expect(
      partialReadNotices(
        [{ kind: "served" }, STATE_BY_KIND.stale, { kind: "served" }],
        READING_SUBJECT,
      ).length,
    ).toBe(1);
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
