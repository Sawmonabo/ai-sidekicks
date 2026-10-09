// The event cursor codec must refuse a corrupted cursor with the typed error rather than resume a
// read at a wrong position, and must write each position in the one spelling it reads back.
import { describe, expect, it } from "vitest";

import {
  EVENT_CURSOR_UNRESOLVABLE_CODE,
  EventCursorUnresolvableError,
  decodeEventCursor,
  encodeEventCursor,
  START_OF_LOG_POSITION,
} from "../event-cursor.js";
import type { EventCursor } from "../id.js";

describe("the event cursor codec — a log position of at least -1, one spelling each", () => {
  it.each([
    ["the start of the log", START_OF_LOG_POSITION],
    ["the first event", 0],
    ["the largest safe position", Number.MAX_SAFE_INTEGER],
  ])("round-trips %s", (_label, position) => {
    expect(decodeEventCursor(encodeEventCursor(position))).toBe(position);
  });

  it.each([
    ["letters", "abc"],
    ["a position below the start of the log", "-2"],
    ["a fraction", "1.5"],
    ["a leading zero", "007"],
    ["a plus sign", "+1"],
    ["an exponent", "1e3"],
    ["negative zero", "-0"],
    ["surrounding whitespace", " 1"],
    ["digits past the safe-integer range", "9007199254740993"],
  ])("REFUSES %s with the typed error", (_label, cursor) => {
    let refusal: unknown;
    try {
      decodeEventCursor(cursor as EventCursor);
    } catch (error: unknown) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(EventCursorUnresolvableError);
    expect(refusal).toMatchObject({ code: EVENT_CURSOR_UNRESOLVABLE_CODE, cursor });
  });

  it.each([
    ["below the start of the log", -2],
    ["a fraction", 1.5],
    ["past the safe-integer range", Number.MAX_SAFE_INTEGER + 1],
    ["not a number", Number.NaN],
  ])("refuses to encode a position %s", (_label, position) => {
    expect(() => encodeEventCursor(position)).toThrow(RangeError);
  });
});
