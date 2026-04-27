// Plan-001 PR #2 — Test C4: `Resource limit error matches
// resource.limit_exceeded shape`.
//
// Backstops Spec-001 AC8: "Each Resource Limits enforcement returns the
// standard `{code: 'resource.limit_exceeded', ...}` error shape and does
// not terminate existing resources."
//
// The schema must be tight — daemon/control-plane both produce these and
// the SDK's retry/backoff logic depends on the wire envelope being exactly
// `{code, message, details: {resource, limit, current}}` with no
// reinterpretable fields.
//
// Coverage shape:
//   • Accepts the canonical shape
//   • Rejects:
//       - wrong `code` literal
//       - missing `message`
//       - missing or malformed `details` (any of resource/limit/current)
//       - extra unknown top-level keys (.strict() guard)
//       - extra unknown details keys (.strict() guard)
//       - non-integer `limit` / `current`
//       - negative `limit` / `current`
import { describe, expect, it } from "vitest";

import {
  ERROR_MESSAGE_MAX_LEN,
  RESOURCE_LABEL_MAX_LEN,
  RESOURCE_LIMIT_EXCEEDED_CODE,
  ResourceLimitExceededErrorSchema,
} from "../error.js";

const buildValidError = () => ({
  code: RESOURCE_LIMIT_EXCEEDED_CODE,
  message: "Cannot admit run: concurrent run limit exceeded for session abc-123.",
  details: {
    resource: "concurrent runs per session",
    limit: 5,
    current: 5,
  },
});

describe("ResourceLimitExceededErrorSchema (C4: resource.limit_exceeded shape)", () => {
  it("exposes the wire code as the literal `resource.limit_exceeded`", () => {
    expect(RESOURCE_LIMIT_EXCEEDED_CODE).toBe("resource.limit_exceeded");
  });

  it("accepts the canonical Spec-001 §Limit Enforcement shape", () => {
    const valid = buildValidError();
    const parsed = ResourceLimitExceededErrorSchema.parse(valid);
    expect(parsed.code).toBe(RESOURCE_LIMIT_EXCEEDED_CODE);
    expect(parsed.details.resource).toBe("concurrent runs per session");
    expect(parsed.details.limit).toBe(5);
    expect(parsed.details.current).toBe(5);
  });

  it("accepts `current` strictly greater than `limit` (overflow case)", () => {
    // The wire schema does NOT enforce `current >= limit`; that's a
    // daemon-side invariant. A test fixture should be free to assert
    // overflow scenarios without tripping the parser.
    const overflow = {
      ...buildValidError(),
      details: { ...buildValidError().details, current: 100 },
    };
    const result = ResourceLimitExceededErrorSchema.safeParse(overflow);
    expect(result.success).toBe(true);
  });

  it("rejects a different error code (e.g. session.limit_exceeded)", () => {
    const broken = { ...buildValidError(), code: "session.limit_exceeded" };
    const result = ResourceLimitExceededErrorSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it.each(["code", "message", "details"] as const)(
    "rejects a top-level shape missing `%s`",
    (field) => {
      const valid = buildValidError();
      const broken = { ...valid } as Record<string, unknown>;
      delete broken[field];
      const result = ResourceLimitExceededErrorSchema.safeParse(broken);
      expect(result.success).toBe(false);
    },
  );

  it.each(["resource", "limit", "current"] as const)(
    "rejects details missing required field `%s`",
    (field) => {
      const valid = buildValidError();
      const brokenDetails = { ...valid.details } as Record<string, unknown>;
      delete brokenDetails[field];
      const result = ResourceLimitExceededErrorSchema.safeParse({
        ...valid,
        details: brokenDetails,
      });
      expect(result.success).toBe(false);
    },
  );

  it("rejects unknown top-level extra fields (.strict() guard)", () => {
    const broken = { ...buildValidError(), httpStatus: 429 };
    const result = ResourceLimitExceededErrorSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects unknown details extra fields (.strict() guard)", () => {
    const valid = buildValidError();
    const broken = {
      ...valid,
      details: { ...valid.details, retryAfter: 30 },
    };
    const result = ResourceLimitExceededErrorSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it.each([
    ["non-integer limit", { limit: 5.5, current: 5 }],
    ["negative limit", { limit: -1, current: 0 }],
    ["non-integer current", { limit: 5, current: 5.5 }],
    ["negative current", { limit: 5, current: -3 }],
  ])("rejects detail-field violation: %s", (_label, override) => {
    const valid = buildValidError();
    const broken = {
      ...valid,
      details: { ...valid.details, ...override },
    };
    const result = ResourceLimitExceededErrorSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects empty `message`", () => {
    const broken = { ...buildValidError(), message: "" };
    const result = ResourceLimitExceededErrorSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects oversized `message` (defense-in-depth length cap)", () => {
    const broken = { ...buildValidError(), message: "x".repeat(ERROR_MESSAGE_MAX_LEN + 1) };
    const result = ResourceLimitExceededErrorSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("accepts `message` at exactly the length cap (boundary)", () => {
    const valid = { ...buildValidError(), message: "x".repeat(ERROR_MESSAGE_MAX_LEN) };
    const result = ResourceLimitExceededErrorSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects oversized `details.resource` (defense-in-depth length cap)", () => {
    const valid = buildValidError();
    const broken = {
      ...valid,
      details: { ...valid.details, resource: "x".repeat(RESOURCE_LABEL_MAX_LEN + 1) },
    };
    const result = ResourceLimitExceededErrorSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  // --------------------------------------------------------------------
  // Round 3: wireFreeFormString helper applied to free-form fields.
  // --------------------------------------------------------------------
  // R2-1: `message` and `details.resource` are now hardened with the same
  // wire-layer guards (whitespace-only + NUL-byte rejection) used on
  // identity and event fields. NUL bytes in `message` would corrupt
  // observability log lines that quote the error verbatim.

  it.each([
    ["single space", " "],
    ["multiple spaces", "   "],
    ["tabs only", "\t\t"],
    ["mixed whitespace", " \t\n "],
  ])("rejects whitespace-only `message`: %s", (_label, value) => {
    const broken = { ...buildValidError(), message: value };
    expect(ResourceLimitExceededErrorSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects NUL-byte `message`", () => {
    const broken = { ...buildValidError(), message: "Limit exceeded\u0000extra" };
    expect(ResourceLimitExceededErrorSchema.safeParse(broken).success).toBe(false);
  });

  it.each([
    ["single space", " "],
    ["multiple spaces", "   "],
    ["tabs only", "\t\t"],
    ["mixed whitespace", " \t\n "],
  ])("rejects whitespace-only `details.resource`: %s", (_label, value) => {
    const valid = buildValidError();
    const broken = {
      ...valid,
      details: { ...valid.details, resource: value },
    };
    expect(ResourceLimitExceededErrorSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects NUL-byte `details.resource`", () => {
    const valid = buildValidError();
    const broken = {
      ...valid,
      details: { ...valid.details, resource: "concurrent\u0000runs" },
    };
    expect(ResourceLimitExceededErrorSchema.safeParse(broken).success).toBe(false);
  });
});
