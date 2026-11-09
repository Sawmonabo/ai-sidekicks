// The event cursor codec must refuse a corrupted cursor with the typed error rather than resume a
// read at a wrong position, and must write each position in the one spelling it reads back. The
// daemon's codec reads the same case table, parsed strictly here with zod, so a cursor one side
// writes the other reads.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../__tests__/case-table.test-support.js";
import {
  SESSION_EVENT_CURSOR_UNRESOLVABLE_CODE,
  type EventCursor,
  validateEventCursor,
} from "../../generated/session/id.js";
import {
  EventCursorUnresolvableError,
  decodeEventCursor,
  encodeEventCursor,
} from "../event-cursor.js";

const eventCursorCases = readCaseTable(
  z
    .object({
      // A number, not a safe integer: a row past the safe range is one the codec must refuse.
      encode: z.array(z.object({ position: z.number(), cursor: z.string().nullable() }).strict()),
      decode: z.array(
        z
          .object({
            cursor: z.custom<EventCursor>((value) => validateEventCursor(value)),
            position: z.int().nullable(),
          })
          .strict(),
      ),
    })
    .strict(),
  "event-cursor.json",
);

describe("the event cursor codec — a log position of at least -1, one spelling each", () => {
  it.each(eventCursorCases.encode)("writes $position as $cursor", ({ position, cursor }) => {
    if (cursor === null) {
      expect(() => encodeEventCursor(position)).toThrow(RangeError);
    } else {
      expect(encodeEventCursor(position)).toBe(cursor);
    }
  });

  // A JavaScript number can be a fraction or not a number, which no row of an integer table holds.
  it.each([
    ["a fraction", 1.5],
    ["not a number", Number.NaN],
  ])("refuses to encode %s", (_label, position) => {
    expect(() => encodeEventCursor(position)).toThrow(RangeError);
  });

  it.each(eventCursorCases.decode)("reads $cursor as $position", ({ cursor, position }) => {
    if (position !== null) {
      expect(decodeEventCursor(cursor)).toBe(position);
      return;
    }
    let refusal: unknown;
    try {
      decodeEventCursor(cursor);
    } catch (error: unknown) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(EventCursorUnresolvableError);
    expect(refusal).toMatchObject({ code: SESSION_EVENT_CURSOR_UNRESOLVABLE_CODE });
  });
});
