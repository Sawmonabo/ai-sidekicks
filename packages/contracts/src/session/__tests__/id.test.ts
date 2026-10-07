// `SessionIdSchema` must reject malformed identifiers: if it accepted one, the daemon and the
// control plane could no longer route reconnects to the right authoritative state. Its accept set
// (`RFC_9562_TEXT_FORM`, shared by every branded UUID id) is RFC 9562 text, case-insensitive on
// every alternative, with the version and variant nibbles still deciding. The event cursor codec
// must refuse a corrupted cursor with the typed error rather than resume a read at a wrong
// position.
import { describe, expect, it } from "vitest";

import { EVENT_CURSOR_UNRESOLVABLE_CODE, EventCursorUnresolvableError } from "../../error.js";
import {
  decodeEventCursor,
  encodeEventCursor,
  START_OF_LOG_POSITION,
  SessionIdSchema,
  type EventCursor,
} from "../id.js";

// A real RFC 9562 v7; version bits are not fabricated because `RFC_9562_TEXT_FORM` validates the
// version nibble and variant bits in their canonical positions.
const VALID_UUID_V7 = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";

describe("SessionIdSchema — RFC 9562 text, case-insensitive on every alternative", () => {
  const MAX_UUID_LOWERCASE = "ffffffff-ffff-ffff-ffff-ffffffffffff";
  const MAX_UUID_UPPERCASE = "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF";
  const MAX_UUID_MIXED_CASE = "FfFfFfFf-ffFF-FFff-fFfF-fFFFffffFFFF";
  const NIL_UUID = "00000000-0000-0000-0000-000000000000";

  it.each([
    ["the Max UUID, lowercase", MAX_UUID_LOWERCASE],
    ["the Max UUID, UPPERCASE", MAX_UUID_UPPERCASE],
    ["the Max UUID, MiXeD case", MAX_UUID_MIXED_CASE],
    ["an uppercase v7", VALID_UUID_V7.toUpperCase()],
    ["a mixed-case v4", "550E8400-e29b-41D4-A716-446655440000"],
    ["the Nil UUID", NIL_UUID],
  ])("accepts %s", (_label, value) => {
    // RFC 9562 section 4 makes UUID hex text case-insensitive, so two spellings of one logical
    // id must not parse differently. Zod's stock `uuid` pattern spells the Nil and Max sentinels
    // as lowercase literals with no `i` flag, and its general alternative cannot admit the Max
    // UUID because a `[1-8]` version nibble rejects `f`.
    expect(SessionIdSchema.parse(value)).toBe(value);
  });

  it.each([
    ["a version-9 nibble", "550e8400-e29b-91d4-a716-446655440000"],
    ["a version-0 nibble", "550e8400-e29b-01d4-a716-446655440000"],
    ["a variant 0xxx form", "550e8400-e29b-41d4-0716-446655440000"],
    ["a variant 11xx form", "550e8400-e29b-41d4-c716-446655440000"],
    ["a 35-character string", "550e8400-e29b-41d4-a716-44665544000"],
    ["a path fragment", "../../etc/passwd"],
    ["an all-f string missing a hyphen", "ffffffffffff-ffff-ffff-ffffffffffff"],
    ["a valid id followed by trailing text", `${VALID_UUID_V7}/../x`],
  ])("REFUSES %s", (_label, value) => {
    // The widening is case and nothing else: the version and variant nibbles still decide, so
    // the Max UUID is admitted by its own alternative, not by a relaxed general form that would
    // also admit a version-9 id.
    expect(SessionIdSchema.safeParse(value).success).toBe(false);
  });
});

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
