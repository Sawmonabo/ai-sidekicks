// PR #2 — Test C1: `SessionId.parse rejects malformed UUIDs`.
//
// If `SessionIdSchema` ever silently accepts a malformed identifier, the
// daemon and control-plane lose the ability to route reconnects to the right
// authoritative state.
//
// Coverage shape:
//   • Accepts valid RFC 9562 UUIDs (v4 admin-provisioned, v7 daemon-emitted)
//   • Rejects:
//       - empty string
//       - non-UUID string
//       - UUID with wrong segment lengths
//       - UUID with a stray suffix
//       - non-string types (number, null, undefined, object)
//   • Successful parse returns a branded `SessionId` (TS-only nominal type)
import { describe, expect, it } from "vitest";

import { SessionIdSchema, type SessionId } from "../session.js";

// Two real RFC 9562 UUIDs; we don't fabricate version bits because the branded
// factory's `RFC_9562_TEXT_FORM` validates the version nibble and variant bits
// in the canonical positions.
const VALID_UUID_V4 = "550e8400-e29b-41d4-a716-446655440000";
const VALID_UUID_V7 = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";

describe("SessionIdSchema (C1: id-format invariant)", () => {
  it("accepts a valid UUID v4 (admin-provisioned control-plane id)", () => {
    const parsed = SessionIdSchema.parse(VALID_UUID_V4);
    expect(parsed).toBe(VALID_UUID_V4);
  });

  it("accepts a valid UUID v7 (daemon-emitted sortable id)", () => {
    const parsed = SessionIdSchema.parse(VALID_UUID_V7);
    expect(parsed).toBe(VALID_UUID_V7);
  });

  it("returns a branded SessionId at the type level", () => {
    // This block does not need a runtime assertion — it's a compile-time
    // proof that the brand survives `.parse()`. If `parse()` ever degrades
    // to `string`, the assignment below will fail to typecheck.
    const parsed: SessionId = SessionIdSchema.parse(VALID_UUID_V4);
    expect(typeof parsed).toBe("string");
  });

  it.each([
    ["empty string", ""],
    ["plain word", "not-a-uuid"],
    ["wrong segment lengths", "550e8400-e29b-41d4-a716-44665544000"],
    ["leading whitespace", " 550e8400-e29b-41d4-a716-446655440000"],
    ["trailing suffix", "550e8400-e29b-41d4-a716-446655440000-extra"],
    ["uppercase letters not in valid hex range", "ZZZe8400-e29b-41d4-a716-446655440000"],
  ])("rejects malformed UUID string: %s", (_label, value) => {
    const result = SessionIdSchema.safeParse(value);
    expect(result.success).toBe(false);
  });

  it.each([
    ["number", 42],
    ["null", null],
    ["undefined", undefined],
    ["object", {}],
    ["array", []],
    ["boolean", true],
  ])("rejects non-string type: %s", (_label, value) => {
    const result = SessionIdSchema.safeParse(value);
    expect(result.success).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// The shared accept set — `internal/branded.ts` `RFC_9562_TEXT_FORM`
// ----------------------------------------------------------------------------
//
// Asserted on `SessionIdSchema` because the predicate is the FACTORY's, not
// this family's: every branded UUID id in the package (`ParticipantId`,
// `ChannelId`, `RunId`, `ArtifactId`, the repo / worktree /
// runtime-node ids) composes the same `brandedUuidIdSchema`, so one family's
// accept set is every family's. `provider-driver.test.ts` pins the same
// properties on `ArtifactIdSchema` — two families, deliberately, so a future
// edit that re-homed one off the factory could not pass by proving the other.

describe("SessionIdSchema — the RFC 9562 accept set is case-insensitive on EVERY alternative", () => {
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
    // RFC 9562 section 4 makes UUID hex text case-insensitive, so two
    // spellings of ONE logical id must not receive two parse results. Before
    // the factory carried its own predicate, Zod's versionless `uuid` regex
    // reached the two sentinels through EXACT LOWERCASE string literals on a
    // pattern with no `i` flag, and its general alternative could not rescue
    // the Max UUID because a `[1-8]` version nibble rejects `f`.
    expect(SessionIdSchema.parse(value)).toBe(value);
  });

  it("does not normalize — case is preserved through the parse", () => {
    // The accept set is case-insensitive; the VALUE is returned untouched.
    // Canonicalization belongs at Map-key / hash-input boundaries
    // (`canonicalizeUuid`), never here: branding in this codebase is
    // cast-based, so a schema transform would not fire on the DB-row read
    // paths where the case-split actually bites.
    expect(SessionIdSchema.parse(MAX_UUID_UPPERCASE)).not.toBe(MAX_UUID_LOWERCASE);
  });

  it.each([
    ["a version-9 nibble", "550e8400-e29b-91d4-a716-446655440000"],
    ["a version-0 nibble", "550e8400-e29b-01d4-a716-446655440000"],
    ["a variant 0xxx form", "550e8400-e29b-41d4-0716-446655440000"],
    ["a variant 11xx form", "550e8400-e29b-41d4-c716-446655440000"],
    ["a 35-character string", "550e8400-e29b-41d4-a716-44665544000"],
    ["a path fragment", "../../etc/passwd"],
    ["an all-f string missing a hyphen", "ffffffffffff-ffff-ffff-ffffffffffff"],
  ])("REFUSES %s", (_label, value) => {
    // The widening is case, and nothing else: the version and variant nibbles
    // still decide, so the Max UUID is admitted by its OWN alternative rather
    // than by a relaxed general form that would also admit a version-9 id.
    expect(SessionIdSchema.safeParse(value).success).toBe(false);
  });
});
