// `SessionIdSchema` must reject malformed identifiers: if it accepted one, the daemon and the
// control plane could no longer route reconnects to the right authoritative state. Its accept set
// (`RFC_9562_TEXT_FORM`, shared by every branded UUID id) is RFC 9562 text, case-insensitive on
// every alternative, with the version and variant nibbles still deciding.
import { describe, expect, it } from "vitest";

import { SessionIdSchema } from "../session.js";

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
