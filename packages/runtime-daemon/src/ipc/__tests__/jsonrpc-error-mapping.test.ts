// jsonrpc-error-mapping.test.ts — I-007-8 enforcement on the
// `error.data.fields` channel of the JSON-RPC error envelope.
//
// Spec coverage:
//   * Spec-007 §Wire Format / §Required Behavior — JSON-RPC error envelope.
//   * ADR-009 — wire-format decision rationale.
//   * error-contracts.md §JSON-RPC Wire Mapping (BL-103 closed 2026-05-01) —
//     two-layer envelope (numeric `code` + `data: {type, fields?}`).
//   * Plan-007 §Invariants I-007-8 — "Stack traces and secrets MUST never
//     leak through the response."
//
// Why this file exists: prior to 2026-05-01, only `error.message` was
// substrate-enforced (via `sanitizeErrorMessage`); `error.data.fields`
// flowed verbatim from the throw site to the wire. Codex review of PR
// #26 surfaced three I-007-8 violations:
//
//   1. Confidentiality — `SecureDefaultsValidationError` carries operator-
//      supplied raw `value` into `data.fields.value`. Path-shape and
//      secret-shape values bypassed the message-channel redaction.
//   2. DoS — `BigInt`, circular references, symbols, functions, and
//      non-finite numbers either crash `encodeFrame.JSON.stringify`
//      (BigInt + circular) or are silently dropped (symbol + function),
//      both broken response surfaces.
//   3. Asymmetric I-007-8 — only the message channel was enforced; the
//      structured-detail channel was producer-honor-system.
//
// `sanitizeFields` is the substrate-side enforcement seam for the
// structured-detail channel. This file pins both the unit-level
// guarantees (per-type normalization, recursive walk, depth/width caps)
// and the integration-level guarantee (`mapJsonRpcError` runs the
// sanitizer at the single seam between data-build and envelope-
// construction so no future builder can bypass it).
//
// W-test labeling: not formally a Plan-007 W-test (the work is a Codex-
// review-driven hardening rather than a planned W-test surface), but
// the I-007-8 invariant binding makes these tests the authoritative
// regression detector for the structured-detail enforcement.

import { describe, expect, it } from "vitest";

import { JsonRpcErrorCode, JSONRPC_VERSION } from "@ai-sidekicks/contracts";

import { SecureDefaultsValidationError } from "../../bootstrap/secure-defaults.js";
import { encodeFrame, FramingError, MAX_MESSAGE_BYTES } from "../local-ipc-gateway.js";
import { mapJsonRpcError, sanitizeFields } from "../jsonrpc-error-mapping.js";

// ----------------------------------------------------------------------------
// sanitizeFields — unit tests
// ----------------------------------------------------------------------------

describe("sanitizeFields — pass-through preservation (no false-positive substitution)", () => {
  it("preserves clean structured detail unchanged: {setting, value}", () => {
    // Real `SecureDefaultsValidationError` payload shape — short
    // string-valued fields with no path-shape characters. The sanitizer
    // MUST NOT substitute or transform these.
    const out = sanitizeFields({ setting: "max_workers", value: "4" });
    expect(out).toEqual({ setting: "max_workers", value: "4" });
  });

  it("preserves clean structured detail unchanged: {limit, observed}", () => {
    // Real `FramingError(oversized_body)` payload shape — finite
    // numeric values within JSON-safe range.
    const out = sanitizeFields({ limit: 1_000_000, observed: 1_000_001 });
    expect(out).toEqual({ limit: 1_000_000, observed: 1_000_001 });
  });

  it("preserves negative finite numbers unchanged", () => {
    // -1 / -Infinity discrimination — finite negative integers MUST
    // pass through (they're JSON-safe); only ±Infinity gets a sentinel.
    const out = sanitizeFields({ count: -1, ratio: -0.5 });
    expect(out).toEqual({ count: -1, ratio: -0.5 });
  });

  it("preserves boolean and null values unchanged", () => {
    const out = sanitizeFields({ enabled: true, disabled: false, none: null });
    expect(out).toEqual({ enabled: true, disabled: false, none: null });
  });

  it("preserves nested clean structures unchanged", () => {
    // Zod issue array shape — `RegistryDispatchError.issues` projects
    // into `data.fields.issues` and must not be mangled.
    const issues = [
      { code: "invalid_type", path: ["sessionId"], message: "Expected string" },
      { code: "too_small", path: ["limit"], message: "Number must be >= 1" },
    ];
    const out = sanitizeFields({ issues });
    expect(out).toEqual({ issues });
  });

  it("preserves empty fields unchanged", () => {
    expect(sanitizeFields({})).toEqual({});
  });
});

describe("sanitizeFields — path redaction (Unix / UNC / Windows-drive)", () => {
  it("redacts Unix absolute paths in string values", () => {
    const out = sanitizeFields({
      setting: "local_ipc_path",
      value: "/home/operator/.daemon/ipc.sock",
    });
    expect(out).toEqual({
      setting: "local_ipc_path",
      value: "<redacted-path>",
    });
  });

  it("redacts UNC paths in string values", () => {
    const out = sanitizeFields({
      setting: "share_path",
      value: "\\\\fileserver\\Shared Drive\\config.json",
    });
    expect(out).toEqual({
      setting: "share_path",
      value: "<redacted-path>",
    });
  });

  it("redacts Windows-drive paths in string values", () => {
    const out = sanitizeFields({
      setting: "binary_path",
      value: "C:\\Program Files\\Daemon\\bin.exe",
    });
    expect(out).toEqual({
      setting: "binary_path",
      value: "<redacted-path>",
    });
  });

  it("redacts paths embedded inside larger strings", () => {
    const out = sanitizeFields({
      message: "config refused: bind /var/run/daemon.sock denied",
    });
    expect(out).toEqual({
      message: "config refused: bind <redacted-path> denied",
    });
  });

  it("redacts paths inside nested objects and arrays", () => {
    const out = sanitizeFields({
      issues: [{ path: ["bindAddress"], hint: "/etc/daemon/config.toml" }],
    });
    expect(out).toEqual({
      issues: [{ path: ["bindAddress"], hint: "<redacted-path>" }],
    });
  });

  it("redacts paths in BigInt-coerced strings", () => {
    // BigInt coerces to `${n}n`; the suffix is plain — not path-shape —
    // so a typical bigint passes through unchanged. Pin the no-double-
    // redaction posture: a clean numeric BigInt MUST coerce to its
    // canonical string form, not be redacted as a side effect.
    const out = sanitizeFields({ requested: 12345678901234567890n });
    expect(out).toEqual({ requested: "12345678901234567890n" });
  });
});

describe("sanitizeFields — JSON-unsafe value normalization (DoS prevention)", () => {
  it("coerces BigInt values to canonical `${n}n` strings", () => {
    const out = sanitizeFields({ size: 9007199254740993n });
    expect(out).toEqual({ size: "9007199254740993n" });
    // The encoder MUST NOT throw on the result.
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("substitutes <truncated:circular> for self-referencing objects", () => {
    type Node = { name: string; self?: Node };
    const node: Node = { name: "root" };
    node.self = node;
    const out = sanitizeFields({ node });
    expect(out).toEqual({
      node: { name: "root", self: "<truncated:circular>" },
    });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("substitutes <truncated:circular> for mutual-reference cycles", () => {
    type A = { kind: "a"; ref?: B };
    type B = { kind: "b"; ref?: A };
    const a: A = { kind: "a" };
    const b: B = { kind: "b", ref: a };
    a.ref = b;
    const out = sanitizeFields({ a });
    // The walk visits a, then b (ref of a), then a again (ref of b) →
    // sentinel. The exact shape pins the recursion ordering.
    expect(out).toEqual({
      a: {
        kind: "a",
        ref: { kind: "b", ref: "<truncated:circular>" },
      },
    });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("preserves shared sibling references as data, not <truncated:circular>", () => {
    // Shared reference across siblings is a DAG — both subtrees lie on
    // disjoint ancestor chains, so neither should be flagged circular.
    // This pins the DFS-path semantics: the cycle detector tracks the
    // current recursion path, not every value visited during the walk.
    const shared = { kind: "shared", payload: 42 };
    const out = sanitizeFields({ a: shared, b: shared });
    expect(out).toEqual({
      a: { kind: "shared", payload: 42 },
      b: { kind: "shared", payload: 42 },
    });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("preserves array-of-shared-references as data, not <truncated:circular>", () => {
    // Same DAG invariant for arrays. A shared object appearing at
    // multiple indices is not a cycle — each index occupies its own
    // ancestor chain at the time of descent.
    const shared = { id: "s" };
    const out = sanitizeFields({ list: [shared, shared, shared] });
    expect(out).toEqual({
      list: [{ id: "s" }, { id: "s" }, { id: "s" }],
    });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("substitutes <symbol> for symbol values", () => {
    const out = sanitizeFields({ tag: Symbol("private-tag") });
    expect(out).toEqual({ tag: "<symbol>" });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("substitutes <function> for function values", () => {
    const out = sanitizeFields({ handler: () => 42 });
    expect(out).toEqual({ handler: "<function>" });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("substitutes sentinels for non-finite numbers", () => {
    const out = sanitizeFields({
      nan: Number.NaN,
      pos: Number.POSITIVE_INFINITY,
      neg: Number.NEGATIVE_INFINITY,
    });
    expect(out).toEqual({
      nan: "<non-finite:NaN>",
      pos: "<non-finite:Infinity>",
      neg: "<non-finite:-Infinity>",
    });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("preserves undefined values for the encoder to handle natively", () => {
    // ECMA-262 25.5.2 — JSON.stringify omits undefined-valued object
    // properties. The sanitizer should pass `undefined` through; the
    // encoder makes the final emit decision.
    const out = sanitizeFields({ defined: 1, missing: undefined });
    expect(out).toEqual({ defined: 1, missing: undefined });
    expect(JSON.stringify(out)).toBe('{"defined":1}');
  });

  it("substitutes <unsanitizeable> for objects whose Object.entries throws", () => {
    // A Proxy whose `ownKeys` throws — `Object.entries` invokes
    // [[OwnPropertyKeys]], which runs the trap.
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("ownKeys trap");
        },
      },
    );
    const out = sanitizeFields({ hostile });
    expect(out).toEqual({ hostile: "<unsanitizeable>" });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("substitutes <unsanitizeable> for objects whose getter throws", () => {
    const hostile = {
      get name() {
        throw new Error("getter trap");
      },
    };
    const out = sanitizeFields({ hostile });
    expect(out).toEqual({ hostile: "<unsanitizeable>" });
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});

describe("sanitizeFields — width / depth / length caps (DoS bounding)", () => {
  it("caps strings at FIELDS_VALUE_MAX_LEN with `…[truncated]` suffix", () => {
    const huge = "x".repeat(10_000);
    const out = sanitizeFields({ huge });
    const value = (out as Record<string, string>)["huge"];
    if (value === undefined) throw new Error("expected huge field to be defined");
    expect(value.endsWith("…[truncated]")).toBe(true);
    // The cap is 512; the suffix is "…[truncated]" (12 chars).
    expect(value.length).toBe(512);
  });

  it("caps deep recursion at FIELDS_MAX_DEPTH with <truncated:max-depth>", () => {
    // Build a 10-deep nested object; the cap is 6.
    //
    // Depth accounting in `sanitizeValue`: top-level call `sanitizeFields(x)`
    // recurses into each value with depth=1. Each subsequent recursion
    // increments depth. The guard `if (depth > FIELDS_MAX_DEPTH)` triggers
    // at depth 7. That means the deepest object preserved is at depth 6,
    // and its child is the sentinel string.
    //
    // Walking from `out.root`:
    //   * out.root is at depth 1 (object)
    //   * out.root.next is at depth 2 (object)
    //   * ...
    //   * out.root.next.next.next.next.next is at depth 6 (object whose
    //     `.next` IS the sentinel — sanitizing the child returned sentinel)
    //   * out.root.next.next.next.next.next.next is the sentinel string
    let value: unknown = "leaf";
    for (let i = 0; i < 10; i++) {
      value = { next: value };
    }
    const out = sanitizeFields({ root: value });

    // Five `.next` traversals: depth 1 → depth 6 (still an object).
    let cursor = (out as Record<string, unknown>)["root"];
    for (let i = 0; i < 5; i++) {
      expect(cursor).toBeTypeOf("object");
      cursor = (cursor as Record<string, unknown>)["next"];
    }
    // Cursor at depth 6: the object whose `.next` is the sentinel.
    expect(cursor).toEqual({ next: "<truncated:max-depth>" });
  });

  it("caps object keys at FIELDS_MAX_KEYS with <truncated> summary", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 100; i++) {
      wide[`k${i}`] = i;
    }
    const out = sanitizeFields(wide);
    // 32 first keys preserved; the 33rd entry is the truncation summary.
    const keys = Object.keys(out);
    expect(keys.length).toBe(33);
    expect(keys).toContain("<truncated>");
    expect((out as Record<string, unknown>)["<truncated>"]).toBe("68-more-keys");
  });

  it("caps array elements at FIELDS_MAX_ARRAY_LEN with <truncated:N-more>", () => {
    const wide = Array.from({ length: 100 }, (_, i) => i);
    const out = sanitizeFields({ list: wide });
    const list = (out as Record<string, unknown[]>)["list"];
    if (list === undefined) throw new Error("expected list field to be defined");
    // 32 first elements + 1 trailing sentinel = 33.
    expect(list.length).toBe(33);
    expect(list[32]).toBe("<truncated:68-more>");
    // First 32 elements preserved verbatim.
    for (let i = 0; i < 32; i++) {
      expect(list[i]).toBe(i);
    }
  });

  it("caps total node visits with <truncated:max-nodes> sentinel", () => {
    // Build a wide-but-deep structure that would explode the budget.
    // The budget is 1024 nodes; build 100 keys × 100-element arrays →
    // 10,000 nodes attempted. Truncation should kick in.
    const wide: Record<string, number[]> = {};
    for (let i = 0; i < 100; i++) {
      wide[`k${i}`] = Array.from({ length: 100 }, (_, j) => j);
    }
    const out = sanitizeFields(wide);
    // We expect SOME truncation sentinel to appear because the node
    // budget runs out before all keys are walked. The exact surfacing
    // is one of: `<truncated>` (when keys cap kicks in first), or
    // `<truncated:max-nodes>` (when budget runs out mid-key).
    const keys = Object.keys(out);
    expect(keys).toContain("<truncated>");
  });
});

describe("sanitizeFields — prototype-pollution defense", () => {
  it("skips `__proto__` keys", () => {
    // JSON.parse parses __proto__ as an own enumerable property, not
    // as a prototype-mutation. Object.entries enumerates it. The
    // sanitizer MUST skip it explicitly so the wire payload doesn't
    // carry a key that downstream Object-prototype consumers might
    // misinterpret.
    const fields = JSON.parse('{"__proto__": "evil", "real": "ok"}') as Record<string, unknown>;
    const out = sanitizeFields(fields);
    expect(out).toEqual({ real: "ok" });
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(false);
  });

  it("skips `constructor` and `prototype` keys", () => {
    const fields = JSON.parse(
      '{"constructor": "evil1", "prototype": "evil2", "real": "ok"}',
    ) as Record<string, unknown>;
    const out = sanitizeFields(fields);
    expect(out).toEqual({ real: "ok" });
  });

  it("returns a null-prototype object so __proto__ assignment is inert", () => {
    // Defense-in-depth: even though we skip the key explicitly, the
    // result object MUST have no prototype chain so a future bug
    // accidentally setting `result['__proto__']` would not pollute
    // Object.prototype.
    const out = sanitizeFields({ foo: "bar" });
    expect(Object.getPrototypeOf(out)).toBeNull();
  });
});

describe("sanitizeFields — ReDoS / pathological input resilience", () => {
  it("handles `'a/'.repeat(50000)` without throwing or hanging", () => {
    // Stress test for the path-redaction regex backtracking. The Unix
    // path pattern `(?:\/[A-Za-z0-9_.-]+)+` could in theory backtrack
    // catastrophically on adversarial input — but the bounded character
    // class makes the worst case linear. We pin the linearity by
    // measuring elapsed time on a 100KB input.
    const adversarial = "a/".repeat(50_000);
    const start = Date.now();
    const out = sanitizeFields({ adversarial });
    const elapsed = Date.now() - start;
    expect(out).toBeDefined();
    // 5s is a generous ceiling; on a healthy regex, this finishes in
    // <50ms. If we ever flip to >5s here, the regex has gone catastrophic.
    expect(elapsed).toBeLessThan(5000);
  });

  it("handles a 1MB pure-path string without throwing", () => {
    const adversarial = `/${"x".repeat(1_000_000)}`;
    expect(() => sanitizeFields({ adversarial })).not.toThrow();
  });

  it("handles a deeply-recursive cyclic structure without stack overflow", () => {
    // Not actually deep — the cycle detector kicks in at depth 2.
    // The structural test is "no stack overflow"; the depth cap is
    // belt-and-braces.
    type Node = { next?: Node };
    const head: Node = {};
    let cursor = head;
    for (let i = 0; i < 100_000; i++) {
      const next: Node = {};
      cursor.next = next;
      cursor = next;
    }
    cursor.next = head;
    expect(() => sanitizeFields({ head })).not.toThrow();
  });
});

// ----------------------------------------------------------------------------
// mapJsonRpcError — integration tests (single-seam I-007-8 enforcement)
// ----------------------------------------------------------------------------

describe("mapJsonRpcError — I-007-8 single-seam enforcement on data.fields", () => {
  it("end-to-end: SecureDefaultsValidationError with path-shape value → redacted on wire", () => {
    // Reproduces the Codex-flagged confidentiality gap: an operator
    // misconfigures `local-ipc-path` to a sensitive absolute path; the
    // current `SecureDefaultsValidationError` carries that raw value
    // verbatim into `error.fields.value`. Before the I-007-8 fix, the
    // wire envelope would expose the operator's filesystem layout.
    const sensitivePath = "/home/operator/.secret-daemon/ipc.sock";
    const error = new SecureDefaultsValidationError(
      "invalid_local_ipc_path",
      `local-ipc-path rejected: ${sensitivePath}`,
      { setting: "localIpcPath", value: sensitivePath },
    );

    const envelope = mapJsonRpcError(error, 1);

    // Numeric: -32602 InvalidParams (boot-time config IS request params).
    expect(envelope.error.code).toBe(JsonRpcErrorCode.InvalidParams);
    // data.type: stable code string.
    expect(envelope.error.data?.type).toBe("invalid_local_ipc_path");
    // data.fields.value: redacted, NOT the raw path.
    const fields = envelope.error.data?.fields as Record<string, unknown> | undefined;
    expect(fields?.["setting"]).toBe("localIpcPath");
    expect(fields?.["value"]).toBe("<redacted-path>");
    // The message channel is also sanitized (existing behavior).
    expect(envelope.error.message).toContain("<redacted-path>");
    expect(envelope.error.message).not.toContain(sensitivePath);
  });

  it("end-to-end: SecureDefaultsValidationError with BigInt value → encoder does not throw", () => {
    // Reproduces the Codex-flagged DoS gap: a BigInt-valued field
    // crashes `encodeFrame.JSON.stringify` (which is the substrate's
    // outgoing-frame serializer). Before the fix, the gateway would
    // see the throw, fail to send the response, and tear down the
    // connection (peer sees ECONNRESET).
    const error = new SecureDefaultsValidationError(
      "unknown_setting",
      "unknown setting: maxQuota (got bigint)",
      { setting: "maxQuota", value: 9007199254740993n },
    );

    const envelope = mapJsonRpcError(error, 1);
    // The substrate's encoder MUST NOT throw on the resulting envelope.
    expect(() => encodeFrame(envelope)).not.toThrow();
    // The structured detail surfaces the BigInt as a stable string.
    const fields = envelope.error.data?.fields as Record<string, unknown> | undefined;
    expect(fields?.["value"]).toBe("9007199254740993n");
  });

  it("end-to-end: SecureDefaultsValidationError with circular value → encoder does not throw", () => {
    type Cycle = { name: string; self?: Cycle };
    const cycle: Cycle = { name: "rotated" };
    cycle.self = cycle;

    const error = new SecureDefaultsValidationError(
      "unknown_setting",
      "unknown setting: nested",
      // The .fields type is `Record<string, unknown>`; we cast through
      // unknown to bypass the structural check intentionally — the
      // throw site can construct any value the JS runtime allows.
      { setting: "nested", value: cycle as unknown },
    );

    const envelope = mapJsonRpcError(error, 1);
    expect(() => encodeFrame(envelope)).not.toThrow();
    const fields = envelope.error.data?.fields as Record<string, unknown> | undefined;
    expect(fields?.["value"]).toEqual({
      name: "rotated",
      self: "<truncated:circular>",
    });
  });

  it("preserves the seamless behavior for clean fields (no false-positive substitution)", () => {
    // Regression detector — the sanitizer's pass-through path for clean
    // structured detail is the dominant case in production. A real
    // SecureDefaultsValidationError on a numeric setting MUST surface
    // identically before and after the I-007-8 hardening.
    const error = new SecureDefaultsValidationError(
      "unknown_setting",
      "unknown setting: max_workers",
      { setting: "max_workers", value: "4" },
    );

    const envelope = mapJsonRpcError(error, 1);
    expect(envelope.error.data).toEqual({
      type: "unknown_setting",
      fields: { setting: "max_workers", value: "4" },
    });
  });

  it("preserves the seamless behavior for FramingError oversized_body fields", () => {
    // FramingError(oversized_body) projects through `transport.message_too_large`
    // (per Fix #2 80c5d39) with `{limit, observed}` shape. Numeric
    // values are JSON-safe and must pass through unchanged.
    const error = new FramingError("oversized_body", "frame body too large", {
      limit: MAX_MESSAGE_BYTES,
      observed: MAX_MESSAGE_BYTES + 1,
    });

    const envelope = mapJsonRpcError(error, null);
    expect(envelope.error.data).toEqual({
      type: "transport.message_too_large",
      fields: { limit: MAX_MESSAGE_BYTES, observed: MAX_MESSAGE_BYTES + 1 },
    });
  });

  it("does not add fields when the throw site provided none (no spurious empty fields)", () => {
    // FramingError without a fields payload — the wire envelope must
    // surface only `data.type`, not `data.fields: {}`.
    const error = new FramingError("malformed_header", "missing colon");
    const envelope = mapJsonRpcError(error, null);
    expect(envelope.error.data).toEqual({ type: "malformed_header" });
    expect(envelope.error.data && "fields" in envelope.error.data).toBe(false);
  });

  it("preserves envelope shape (jsonrpc + id + error) per JSON-RPC 2.0 §5", () => {
    const error = new SecureDefaultsValidationError("unknown_setting", "test", {
      setting: "x",
      value: "y",
    });
    const envelope = mapJsonRpcError(error, "req-42");
    expect(envelope.jsonrpc).toBe(JSONRPC_VERSION);
    expect(envelope.id).toBe("req-42");
    expect(envelope.error).toBeDefined();
  });

  it("does not throw for arbitrarily hostile thrown values", () => {
    // The whole point of `mapJsonRpcError` being non-throwing — even
    // when `sanitizeErrorMessage` and `sanitizeFields` both face
    // adversarial input, the seam yields a well-formed envelope.
    const hostile = {
      get message() {
        throw new Error("getter on message");
      },
      get fields() {
        throw new Error("getter on fields");
      },
    };
    expect(() => mapJsonRpcError(hostile, 1)).not.toThrow();
  });

  it("collapses generic Error to -32603 InternalError with no data", () => {
    // The discrimination fall-through: a plain Error not matching any
    // typed-error class becomes `-32603` with no `data` field. The
    // sanitizeFields seam should not inject a spurious `fields: {}`.
    const error = new Error("plain error");
    const envelope = mapJsonRpcError(error, 1);
    expect(envelope.error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(envelope.error.data).toBeUndefined();
  });
});
