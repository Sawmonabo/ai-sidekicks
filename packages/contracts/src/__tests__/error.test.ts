// The `resource.limit_exceeded` and `PtyBackendUnavailable` error envelopes. Daemon and
// control plane both produce them and the SDK's retry and backoff logic keys on the exact
// wire shape, so the schemas must be tight: the canonical shape is accepted, and a wrong
// code, missing or malformed fields, non-integer or negative counts, and extra keys at
// either level are refused.
import { describe, expect, it } from "vitest";

import {
  ERROR_MESSAGE_MAX_LEN,
  EVENT_CURSOR_UNRESOLVABLE_CODE,
  PTY_BACKEND_UNAVAILABLE_CODE,
  PtyBackendUnavailableSchema,
  RESOURCE_LABEL_MAX_LEN,
  RESOURCE_LIMIT_EXCEEDED_CODE,
  ResourceLimitExceededErrorSchema,
} from "../error.js";

// A single NUL byte, which `wireFreeFormString` rejects on the wire.
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

  it("accepts the canonical shape", () => {
    const valid = buildValidError();
    const parsed = ResourceLimitExceededErrorSchema.parse(valid);
    expect(parsed.code).toBe(RESOURCE_LIMIT_EXCEEDED_CODE);
    expect(parsed.details.resource).toBe("concurrent runs per session");
    expect(parsed.details.limit).toBe(5);
    expect(parsed.details.current).toBe(5);
  });

  it("accepts `current` strictly greater than `limit` (overflow case)", () => {
    // The wire schema does not enforce `current >= limit`; the daemon does.
    const overflow = {
      ...buildValidError(),
      details: { ...buildValidError().details, current: 100 },
    };
    const result = ResourceLimitExceededErrorSchema.safeParse(overflow);
    expect(result.success).toBe(true);
  });

  it("rejects a different error code (e.g. PtyBackendUnavailable)", () => {
    const broken = { ...buildValidError(), code: PTY_BACKEND_UNAVAILABLE_CODE };
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

  // `message` and `details.resource` reject whitespace-only and NUL-byte values; a NUL in
  // `message` would corrupt log lines that quote the error verbatim.

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

// Thrown by the daemon's PTY host selector, the Rust sidecar host and the sidecar binary
// resolver. `cause` may be absent or any value; `attemptedBackend` is a closed set. NUL-byte
// rejection on `message` is covered by the suite above.

const buildValidPtyError = () => ({
  code: PTY_BACKEND_UNAVAILABLE_CODE,
  message: "PTY backend 'rust-sidecar' could not be initialized; node-pty fallback unavailable.",
  details: {
    attemptedBackend: "rust-sidecar" as const,
  },
});

describe("PtyBackendUnavailableSchema", () => {
  it("exposes the wire code as the literal `PtyBackendUnavailable`", () => {
    expect(PTY_BACKEND_UNAVAILABLE_CODE).toBe("PtyBackendUnavailable");
  });

  it("accepts the canonical", () => {
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

// The cursor refusal is a code-and-message registration with no schema, so the literal
// string is the contract: the daemon raises it and the desktop's resume classifier branches on
// it. A typo would make that branch unreachable without failing anything else.
describe("event-read cursor refusal code", () => {
  it("exposes the cursor code as the literal `event.cursor_unresolvable`", () => {
    expect(EVENT_CURSOR_UNRESOLVABLE_CODE).toBe("event.cursor_unresolvable");
  });
});
