// Plan-001 PR #2 — Test C1: `SessionId.parse rejects malformed UUIDs`.
//
// Asserts the id-format invariant that backstops Spec-001 acceptance criteria
// AC1 (session id stable from create), AC3 (id stable across reconnect), and
// AC4 (rejoin returns the same id). If `SessionIdSchema` ever silently accepts
// a malformed identifier, the daemon and control-plane lose the ability to
// route reconnects to the right authoritative state.
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

// Two real RFC 9562 UUIDs; we don't fabricate version bits because z.uuid()
// validates the version nibble and variant bits in the canonical positions.
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
