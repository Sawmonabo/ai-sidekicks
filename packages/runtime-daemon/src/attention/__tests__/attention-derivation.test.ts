// The session-level attention item names one run-level item as its representative,
// and every reader of the projection must name the same one. These cases pin the
// choice where a text comparison of timestamps would pick wrongly.
import { describe, expect, it } from "vitest";

import { deriveSessionAggregate } from "../attention-derivation.js";

describe("deriveSessionAggregate", () => {
  it("orders by instant, so an earlier offset stamp beats a later Z stamp", () => {
    // 16:00+05:00 is 11:00Z, before 12:00Z, though it sorts after it as text.
    const earlierInOffsetForm = {
      id: "b",
      severity: "informational",
      createdAt: "2026-03-01T16:00:00+05:00",
    } as const;
    const laterInZForm = {
      id: "a",
      severity: "informational",
      createdAt: "2026-03-01T12:00:00Z",
    } as const;
    const aggregate = deriveSessionAggregate([laterInZForm, earlierInOffsetForm]);
    expect(aggregate?.representative).toBe(earlierInOffsetForm);
  });

  it("ties two spellings of one moment and lets the smaller id decide", () => {
    const zForm = {
      id: "b",
      severity: "informational",
      createdAt: "2026-03-01T14:30:00Z",
    } as const;
    const offsetForm = {
      id: "a",
      severity: "informational",
      createdAt: "2026-03-01T19:30:00+05:00",
    } as const;
    expect(deriveSessionAggregate([zForm, offsetForm])?.representative).toBe(offsetForm);
  });

  it("prefers an actionable item over an earlier informational one and is actionable", () => {
    const informational = {
      id: "a",
      severity: "informational",
      createdAt: "2026-03-01T10:00:00Z",
    } as const;
    const actionable = {
      id: "b",
      severity: "actionable",
      createdAt: "2026-03-01T11:00:00Z",
    } as const;
    const aggregate = deriveSessionAggregate([informational, actionable]);
    expect(aggregate).toEqual({ representative: actionable, severity: "actionable" });
  });
});
