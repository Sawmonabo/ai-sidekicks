// What a session row says about WHEN it was last touched.
//
// The list groups by tier — the front tier a person pinned, and everything else —
// and it carries no day divider anywhere. So the touched-at reading is the only
// thing on the row that can say which day it belongs to, and a clock-only reading
// made two sessions a week apart at the same minute identical on screen. That is a
// property no type can state and one this file asserts directly.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatClockTime, formatDateTime } from "../primitives/index.js";
import { SessionList } from "./SessionList.js";
import type { SessionListRow } from "./rows/session-rows.js";

/** The same wall-clock minute on two different calendar days. */
const TOUCHED_TODAY = "2026-01-01T09:30:00.000Z";
const TOUCHED_NEXT_DAY = "2026-01-02T09:30:00.000Z";

function row(overrides: Partial<SessionListRow> = {}): SessionListRow {
  return {
    sessionId: "session-1",
    state: "active",
    touchedAtIso: TOUCHED_TODAY,
    participantIds: [],
    attentionSeverity: undefined,
    ...overrides,
  };
}

function renderList(rows: readonly SessionListRow[]): HTMLElement {
  const { container } = render(
    <SessionList
      rows={rows}
      tierBySessionId={{}}
      onOpen={() => undefined}
      onSetTier={() => undefined}
    />,
  );
  return container;
}

/**
 * The touched-at readings, one per row.
 *
 * Selected as DIRECT children of the facts row, which is what separates the instant
 * from the participant identifiers rendered beside it in their own wrapper — a
 * looser selector would fold the two together and the assertion would stop being
 * about the instant at all.
 */
function touchedReadings(container: HTMLElement): readonly string[] {
  return [
    ...container.querySelectorAll(".meridian-session-row__facts > .meridian-figure--wire"),
  ].map((figure) => figure.textContent ?? "");
}

describe("the instant a session was last touched", () => {
  it("renders two sessions a day apart as two different readings", () => {
    const container = renderList([
      row({ sessionId: "session-today", touchedAtIso: TOUCHED_TODAY }),
      row({ sessionId: "session-next-day", touchedAtIso: TOUCHED_NEXT_DAY }),
    ]);
    const readings = touchedReadings(container);
    expect(readings).toContain(formatDateTime(TOUCHED_TODAY));
    expect(readings).toContain(formatDateTime(TOUCHED_NEXT_DAY));
    expect(new Set(readings).size).toBe(2);
  });

  it("negative control: the clock-only reading of those two instants is one string", () => {
    // Without this the case above would pass over two instants that were never a
    // collision, and would prove nothing about which formatter the row reaches for.
    expect(formatClockTime(TOUCHED_NEXT_DAY)).toBe(formatClockTime(TOUCHED_TODAY));
  });

  it("keeps the exact instant on the figure's own title, unformatted", () => {
    const container = renderList([row()]);
    const titles = [
      ...container.querySelectorAll(".meridian-session-row__facts > .meridian-figure--wire"),
    ].map((figure) => figure.getAttribute("title"));
    expect(titles).toStrictEqual([TOUCHED_TODAY]);
  });

  it("renders no instant at all where the wire named none", () => {
    // `undefined` is a real answer and the row says nothing rather than composing
    // one — the absence this reading must not fill in.
    const container = renderList([row({ touchedAtIso: undefined })]);
    expect(touchedReadings(container)).toStrictEqual([]);
  });
});
