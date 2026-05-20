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
//
// Plan-024 Phase 3 §F-024-3-02 — Test: `PtyBackendUnavailable wire shape`.
// Same shape-checking discipline as the resource.limit_exceeded suite —
// daemon throwers (PtyHostSelector, RustSidecarPtyHost,
// resolveSidecarBinaryPath) all produce these envelopes and SDK consumers
// (UI banners, diagnostics renderers) compare on `code` + `attemptedBackend`.
import { describe, expect, it } from "vitest";

import {
  ERROR_MESSAGE_MAX_LEN,
  PTY_BACKEND_UNAVAILABLE_CODE,
  PtyBackendUnavailableSchema,
  RESOURCE_LABEL_MAX_LEN,
  RESOURCE_LIMIT_EXCEEDED_CODE,
  ResourceLimitExceededErrorSchema,
  VERSION_CEILING_EXCEEDED_CODE,
  VERSION_FLOOR_EXCEEDED_CODE,
  VERSION_STRING_MAX_LEN,
  VERSION_UPGRADE_PATH_MAX_LEN,
  VersionCeilingExceededErrorSchema,
  VersionFloorExceededErrorSchema,
} from "../error.js";

// `NUL` is a runtime-equivalent template-literal NUL byte for test fixtures.
// Both `${NUL}` and a unicode-escape-zero source escape produce a 1-char
// string containing a single NUL byte at runtime, which is what
// `wireFreeFormString` rejects on the wire.
const NUL = String.fromCharCode(0);

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
    const broken = { ...buildValidError(), message: `Limit exceeded${NUL}extra` };
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
      details: { ...valid.details, resource: `concurrent${NUL}runs` },
    };
    expect(ResourceLimitExceededErrorSchema.safeParse(broken).success).toBe(false);
  });
});

// --------------------------------------------------------------------------
// PtyBackendUnavailable — Plan-024 Phase 3 §F-024-3-02 wire shape.
// --------------------------------------------------------------------------
//
// Throwers: PtyHostSelector (sidecar binary missing AND fallback also
// unavailable; env-var coerces to unknown backend), RustSidecarPtyHost
// (5-failures-per-60s crash budget exhausted), resolveSidecarBinaryPath
// (all 4 resolution tiers exhausted). Per ADR-019 §Failure Mode Analysis
// row "Sidecar binary missing on user machine".
//
// Coverage shape:
//   • Accepts the canonical {code, message, details: {attemptedBackend, cause?}}
//   • `cause` is omittable (key may be absent)
//   • `cause` accepts arbitrary values (string, object, null, number)
//   • `attemptedBackend` enum is closed: rejects unknown backend strings
//   • Rejects: wrong code literal, missing top-level fields, extra keys
//     (.strict() guard at both levels), missing `attemptedBackend`
//
// NUL-byte rejection on `message` is already covered upstream by the
// `wireFreeFormString` helper (which the new schema reuses) and exercised
// by the `ResourceLimitExceededError` suite above. Not re-tested here.

const buildValidPtyError = () => ({
  code: PTY_BACKEND_UNAVAILABLE_CODE,
  message: "PTY backend 'rust-sidecar' could not be initialized; node-pty fallback unavailable.",
  details: {
    attemptedBackend: "rust-sidecar" as const,
  },
});

describe("PtyBackendUnavailableSchema (Plan-024 §F-024-3-02 wire shape)", () => {
  it("exposes the wire code as the literal `PtyBackendUnavailable`", () => {
    expect(PTY_BACKEND_UNAVAILABLE_CODE).toBe("PtyBackendUnavailable");
  });

  it("accepts the canonical Plan-024 §F-024-3-02 shape (cause omitted)", () => {
    const valid = buildValidPtyError();
    const parsed = PtyBackendUnavailableSchema.parse(valid);
    expect(parsed.code).toBe(PTY_BACKEND_UNAVAILABLE_CODE);
    expect(parsed.details.attemptedBackend).toBe("rust-sidecar");
    expect(parsed.details.cause).toBeUndefined();
  });

  it("accepts `attemptedBackend: 'node-pty'` (the second enum member)", () => {
    const valid = {
      ...buildValidPtyError(),
      details: { attemptedBackend: "node-pty" as const },
    };
    const parsed = PtyBackendUnavailableSchema.parse(valid);
    expect(parsed.details.attemptedBackend).toBe("node-pty");
  });

  it.each([
    ["string cause (path)", "/Users/foo/.cache/sidecar"],
    ["object cause (errno)", { errno: -2, code: "ENOENT", syscall: "open" }],
    ["nested object cause (JSON-RPC error)", { jsonrpc: "2.0", error: { code: -32603 } }],
    ["null cause", null],
    ["number cause", 42],
  ])("accepts arbitrary `cause` shape: %s", (_label, cause) => {
    const valid = {
      ...buildValidPtyError(),
      details: { ...buildValidPtyError().details, cause },
    };
    const result = PtyBackendUnavailableSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects a different error code (e.g. resource.limit_exceeded)", () => {
    const broken = { ...buildValidPtyError(), code: "resource.limit_exceeded" };
    const result = PtyBackendUnavailableSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it.each(["code", "message", "details"] as const)(
    "rejects a top-level shape missing `%s`",
    (field) => {
      const valid = buildValidPtyError();
      const broken = { ...valid } as Record<string, unknown>;
      delete broken[field];
      const result = PtyBackendUnavailableSchema.safeParse(broken);
      expect(result.success).toBe(false);
    },
  );

  it("rejects details missing required field `attemptedBackend`", () => {
    const broken = {
      ...buildValidPtyError(),
      details: {} as Record<string, unknown>,
    };
    const result = PtyBackendUnavailableSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it.each([
    ["lowercase variant", "rust_sidecar"],
    ["unknown backend", "winpty"],
    ["empty string", ""],
    ["adjacent typo", "rust-sidcar"],
  ])("rejects unknown `attemptedBackend` enum value: %s", (_label, value) => {
    const broken = {
      ...buildValidPtyError(),
      details: { attemptedBackend: value },
    };
    const result = PtyBackendUnavailableSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level extra fields (.strict() guard)", () => {
    const broken = { ...buildValidPtyError(), httpStatus: 500 };
    const result = PtyBackendUnavailableSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects unknown details extra fields (.strict() guard)", () => {
    const valid = buildValidPtyError();
    const broken = {
      ...valid,
      details: { ...valid.details, retryAfter: 30 },
    };
    const result = PtyBackendUnavailableSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects empty `message`", () => {
    const broken = { ...buildValidPtyError(), message: "" };
    const result = PtyBackendUnavailableSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects oversized `message` (defense-in-depth length cap)", () => {
    const broken = { ...buildValidPtyError(), message: "x".repeat(ERROR_MESSAGE_MAX_LEN + 1) };
    const result = PtyBackendUnavailableSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("accepts `message` at exactly the length cap (boundary)", () => {
    const valid = { ...buildValidPtyError(), message: "x".repeat(ERROR_MESSAGE_MAX_LEN) };
    const result = PtyBackendUnavailableSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// VersionFloorExceededError + VersionCeilingExceededError (Plan-001 T2.3)
// ----------------------------------------------------------------------------
//
// Floor and ceiling errors share `VersionBoundExceededDetails` — they are
// the SAME shape with two different code literals (per ADR-018 §Decision
// #10). The test suites here are deliberately parallel so a future
// divergence (e.g. floor variant gaining an extra field) shows up as a
// test-suite skew at PR review.

const buildValidFloorError = () => ({
  code: VERSION_FLOOR_EXCEEDED_CODE,
  message: "Client protocol version 0.9 is below daemon's accepted floor 1.0.",
  details: {
    attemptedVersion: "0.9",
    acceptedRange: { min: "1.0", max: "2.0" },
    upgradePath: "Upgrade the client to 1.0 or higher: https://example.com/upgrade",
  },
});

const buildValidCeilingError = () => ({
  code: VERSION_CEILING_EXCEEDED_CODE,
  message: "Client protocol version 3.0 is above daemon's accepted ceiling 2.0.",
  details: {
    attemptedVersion: "3.0",
    acceptedRange: { min: "1.0", max: "2.0" },
    upgradePath: "Downgrade the client to 2.0 or lower.",
  },
});

describe("VersionFloorExceededErrorSchema", () => {
  it("accepts the canonical floor-exceeded envelope round-trip", () => {
    const valid = buildValidFloorError();
    const parsed = VersionFloorExceededErrorSchema.parse(valid);
    const serialized = JSON.stringify(parsed);
    const reparsed = VersionFloorExceededErrorSchema.parse(JSON.parse(serialized));
    expect(reparsed).toEqual(valid);
  });

  it("accepts the envelope without `upgradePath` (optional field)", () => {
    const valid = buildValidFloorError();
    delete (valid.details as { upgradePath?: string }).upgradePath;
    const result = VersionFloorExceededErrorSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects a wrong `code` literal (ceiling code on floor schema)", () => {
    const broken = { ...buildValidFloorError(), code: VERSION_CEILING_EXCEEDED_CODE };
    const result = VersionFloorExceededErrorSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects an unrelated dotted-namespace code", () => {
    const broken = { ...buildValidFloorError(), code: "version.something_else" as never };
    const result = VersionFloorExceededErrorSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects an oversized `attemptedVersion`", () => {
    const broken = buildValidFloorError();
    broken.details.attemptedVersion = "x".repeat(VERSION_STRING_MAX_LEN + 1);
    const result = VersionFloorExceededErrorSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only `attemptedVersion`", () => {
    const broken = buildValidFloorError();
    broken.details.attemptedVersion = "   ";
    const result = VersionFloorExceededErrorSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects an oversized `upgradePath`", () => {
    const broken = buildValidFloorError();
    broken.details.upgradePath = "x".repeat(VERSION_UPGRADE_PATH_MAX_LEN + 1);
    const result = VersionFloorExceededErrorSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects an unknown top-level key (strict mode)", () => {
    const broken = { ...buildValidFloorError(), extra: "rejected" };
    const result = VersionFloorExceededErrorSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects an unknown details key (strict mode)", () => {
    const broken = buildValidFloorError();
    (broken.details as { extra?: string }).extra = "rejected";
    const result = VersionFloorExceededErrorSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects an unknown acceptedRange key (strict mode)", () => {
    const broken = buildValidFloorError();
    (broken.details.acceptedRange as { extra?: string }).extra = "rejected";
    const result = VersionFloorExceededErrorSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects a missing `acceptedRange.min`", () => {
    const broken = buildValidFloorError();
    delete (broken.details.acceptedRange as Partial<typeof broken.details.acceptedRange>).min;
    const result = VersionFloorExceededErrorSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("accepts boundary lengths (attemptedVersion + upgradePath at cap)", () => {
    const valid = buildValidFloorError();
    valid.details.attemptedVersion = "x".repeat(VERSION_STRING_MAX_LEN);
    valid.details.upgradePath = "y".repeat(VERSION_UPGRADE_PATH_MAX_LEN);
    const result = VersionFloorExceededErrorSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });
});

describe("VersionCeilingExceededErrorSchema", () => {
  it("accepts the canonical ceiling-exceeded envelope round-trip", () => {
    const valid = buildValidCeilingError();
    const parsed = VersionCeilingExceededErrorSchema.parse(valid);
    const serialized = JSON.stringify(parsed);
    const reparsed = VersionCeilingExceededErrorSchema.parse(JSON.parse(serialized));
    expect(reparsed).toEqual(valid);
  });

  it("rejects a wrong `code` literal (floor code on ceiling schema)", () => {
    const broken = { ...buildValidCeilingError(), code: VERSION_FLOOR_EXCEEDED_CODE };
    const result = VersionCeilingExceededErrorSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects an oversized `acceptedRange.max`", () => {
    const broken = buildValidCeilingError();
    broken.details.acceptedRange.max = "x".repeat(VERSION_STRING_MAX_LEN + 1);
    const result = VersionCeilingExceededErrorSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects NUL-byte in `message`", () => {
    const broken = { ...buildValidCeilingError(), message: `bad${NUL}message` };
    const result = VersionCeilingExceededErrorSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });
});
