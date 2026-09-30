// What a session row says about when it was last touched. The list has no day divider, so
// the touched-at reading is the only thing that can say which day a row belongs to.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatClockTime, formatDateTime } from "@renderer/lib/wire-figures.js";
import { SessionList } from "./SessionList.js";
import type { SessionListRow } from "../rows/session-rows.js";

/** The same wall-clock minute on two different calendar days. */
const TOUCHED_TODAY = "2026-01-01T09:30:00.000Z";
const TOUCHED_NEXT_DAY = "2026-01-02T09:30:00.000Z";

function row(overrides: Partial<SessionListRow> = {}): SessionListRow {
  return {
    sessionId: "session-1",
    state: "active",
    touchedAtIso: TOUCHED_TODAY,
    userIds: [],
    attentionSeverity: undefined,
    ...overrides,
  };
}

function renderList(rows: readonly SessionListRow[]): HTMLElement {
  const { container } = render(<SessionList rows={rows} pinned={{}} onOpen={() => undefined} />);
  return container;
}

/**
 * The touched-at readings, one per row. Selected as direct children of the facts row, which
 * separates the instant from the user identifiers rendered beside it.
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
    // Without this the case above could pass over two instants that never collided.
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
    // `undefined` is a real answer; the row says nothing rather than composing an instant.
    const container = renderList([row({ touchedAtIso: undefined })]);
    expect(touchedReadings(container)).toStrictEqual([]);
  });
});
