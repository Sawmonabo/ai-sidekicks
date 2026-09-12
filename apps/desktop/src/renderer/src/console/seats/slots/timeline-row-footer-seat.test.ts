// The footer seat's own cases: who may fill it, and which rows it is offered on.

import { afterEach, describe, expect, it } from "vitest";

import {
  TIMELINE_ROW_FOOTER_SLOT_CONTRACT,
  TIMELINE_ROW_FOOTER_TYPES,
  registerTimelineRowFooterRenderer,
  rowTakesFooter,
  timelineRowFooterRenderer,
  unregisterTimelineRowFooterRenderer,
} from "./timeline-row-footer-seat.js";
import type { SessionId, TimelineRow } from "@ai-sidekicks/contracts";

/**
 * A general-arm row, built here rather than borrowed.
 *
 * The ledger's fixture builders sit in a VIEW family, which is above `seats/` on the
 * console DAG — reaching for them from a seat's own suite would be the upward edge
 * the layering gate reports. Two literals are the cheaper answer than a shared
 * builder no other seat suite needs.
 */
function generalRowOfType(type: string): TimelineRow {
  return {
    kind: "general",
    id: `row-${type}`,
    sessionId: "11111111-2222-4333-8444-555555555555" as SessionId,
    sequence: 1,
    category: "interactive_request",
    type,
    summary: `a ${type} row`,
    timestamp: "2026-09-02T09:00:01.000Z",
    payload: {},
  };
}

afterEach(() => {
  unregisterTimelineRowFooterRenderer();
});

describe("the timeline row footer seat", () => {
  it("is empty until an owner fills it", () => {
    expect(timelineRowFooterRenderer()).toBeUndefined();
    registerTimelineRowFooterRenderer("an owner", () => null);
    expect(timelineRowFooterRenderer()).toBeDefined();
  });

  it("refuses a second owner rather than swapping", () => {
    registerTimelineRowFooterRenderer("first owner", () => null);
    expect(() => {
      registerTimelineRowFooterRenderer("second owner", () => null);
    }).toThrow(/second owner/);
  });

  it("admits the same owner again, for a hot reload", () => {
    registerTimelineRowFooterRenderer("one owner", () => null);
    expect(() => {
      registerTimelineRowFooterRenderer("one owner", () => null);
    }).not.toThrow();
  });

  it("offers the footer on a user message and on nothing else", () => {
    expect(rowTakesFooter(generalRowOfType("user.message"))).toBe(true);
    // The negative control: the predicate reads the row's own type rather than
    // answering true for whatever it is handed.
    expect(rowTakesFooter(generalRowOfType("tool.error"))).toBe(false);
  });

  it("names one row type, so the membership question has one home", () => {
    expect([...TIMELINE_ROW_FOOTER_TYPES]).toStrictEqual(["user.message"]);
  });

  it("answers the three facts a plan-owned slot owes", () => {
    expect(TIMELINE_ROW_FOOTER_SLOT_CONTRACT.owningTask).not.toBe("");
    expect(TIMELINE_ROW_FOOTER_SLOT_CONTRACT.mountObligation).not.toBe("");
    expect(TIMELINE_ROW_FOOTER_SLOT_CONTRACT.deleteShellIn).not.toBe("");
  });
});
