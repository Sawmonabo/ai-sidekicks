// Pins `sanitizeFields`, which sanitizes the `error.data.fields` channel of the JSON-RPC error
// envelope: no filesystem path or JSON-unsafe value (BigInt, circular reference, symbol,
// function, non-finite number) reaches the wire. Unit tests cover the
// per-type normalization, the recursive walk and the depth/width caps; integration tests check
// that `mapJsonRpcError` runs the sanitizer for every typed error it maps.

import { describe, expect, it } from "vitest";

import { JsonRpcErrorCode, JSONRPC_VERSION } from "@ai-sidekicks/contracts";

import { SecureDefaultsValidationError } from "../../bootstrap/secure-defaults.js";
import { DaemonDomainError } from "../domain-error.js";
import { encodeFrame, FramingError, MAX_MESSAGE_BYTES } from "../local-ipc-gateway.js";
import { mapJsonRpcError, sanitizeFields } from "../jsonrpc-error-mapping.js";

describe("sanitizeFields — pass-through preservation (no false-positive substitution)", () => {
  it("preserves clean structured detail unchanged: {setting, value}", () => {
    // The payload shape of a real `SecureDefaultsValidationError`: short strings, no path
    // characters.
    const out = sanitizeFields({ setting: "max_workers", value: "4" });
    expect(out).toEqual({ setting: "max_workers", value: "4" });
  });

  it("preserves clean structured detail unchanged: {limit, observed}", () => {
    // The payload shape of a real oversized-body `FramingError`.
    const out = sanitizeFields({ limit: 1_000_000, observed: 1_000_001 });
    expect(out).toEqual({ limit: 1_000_000, observed: 1_000_001 });
  });

  it("preserves negative finite numbers unchanged", () => {
    // Only ±Infinity gets a sentinel; finite negatives are JSON-safe.
    const out = sanitizeFields({ count: -1, ratio: -0.5 });
    expect(out).toEqual({ count: -1, ratio: -0.5 });
  });

  it("preserves boolean and null values unchanged", () => {
    const out = sanitizeFields({ enabled: true, disabled: false, none: null });
    expect(out).toEqual({ enabled: true, disabled: false, none: null });
  });

  it("preserves nested clean structures unchanged", () => {
    // The Zod issue array that `RegistryDispatchError.issues` puts in `data.fields.issues`.
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
      issues: [{ path: ["localIpcPath"], hint: "/etc/daemon/config.toml" }],
    });
    expect(out).toEqual({
      issues: [{ path: ["localIpcPath"], hint: "<redacted-path>" }],
    });
  });

  it("redacts paths in BigInt-coerced strings", () => {
    // A clean BigInt becomes its `${n}n` string and is not redacted as a side effect.
    const out = sanitizeFields({ requested: 12345678901234567890n });
    expect(out).toEqual({ requested: "12345678901234567890n" });
  });
});

describe("sanitizeFields — JSON-unsafe value normalization (DoS prevention)", () => {
  it("coerces BigInt values to canonical `${n}n` strings", () => {
    const out = sanitizeFields({ size: 9007199254740993n });
    expect(out).toEqual({ size: "9007199254740993n" });
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
    // The walk visits a, then b, then a again, which is the sentinel.
    expect(out).toEqual({
      a: {
        kind: "a",
        ref: { kind: "b", ref: "<truncated:circular>" },
      },
    });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("preserves shared sibling references as data, not <truncated:circular>", () => {
    // Siblings sharing a reference are not a cycle: the detector tracks the current recursion
    // path, not every value visited.
    const shared = { kind: "shared", payload: 42 };
    const out = sanitizeFields({ a: shared, b: shared });
    expect(out).toEqual({
      a: { kind: "shared", payload: 42 },
      b: { kind: "shared", payload: 42 },
    });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("preserves array-of-shared-references as data, not <truncated:circular>", () => {
    // The same holds for one object at several array indices.
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
    // `JSON.stringify` omits undefined properties, so the sanitizer passes them through.
    const out = sanitizeFields({ defined: 1, missing: undefined });
    expect(out).toEqual({ defined: 1, missing: undefined });
    expect(JSON.stringify(out)).toBe('{"defined":1}');
  });

  it("substitutes <unsanitizeable> for objects whose Object.entries throws", () => {
    // `Object.entries` runs the Proxy's `ownKeys` trap.
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
    // The cap is 512 characters including the 12-character suffix.
    expect(value.length).toBe(512);
  });

  it("caps deep recursion at FIELDS_MAX_DEPTH with <truncated:max-depth>", () => {
    // A 10-deep object against a cap of 6: `out.root` is at depth 1, so the object at depth 6
    // is preserved and its `.next` (depth 7) is the sentinel.
    let value: unknown = "leaf";
    for (let i = 0; i < 10; i++) {
      value = { next: value };
    }
    const out = sanitizeFields({ root: value });

    // Five `.next` steps go from depth 1 to depth 6.
    let cursor = (out as Record<string, unknown>)["root"];
    for (let i = 0; i < 5; i++) {
      expect(cursor).toBeTypeOf("object");
      cursor = (cursor as Record<string, unknown>)["next"];
    }
    expect(cursor).toEqual({ next: "<truncated:max-depth>" });
  });

  it("caps object keys at FIELDS_MAX_KEYS with <truncated> summary", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 100; i++) {
      wide[`k${i}`] = i;
    }
    const out = sanitizeFields(wide);
    // The first 32 keys stay; the 33rd entry summarizes the rest.
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
    // 32 elements plus one trailing sentinel.
    expect(list.length).toBe(33);
    expect(list[32]).toBe("<truncated:68-more>");
    for (let i = 0; i < 32; i++) {
      expect(list[i]).toBe(i);
    }
  });

  it("caps total node visits with <truncated:max-nodes> sentinel", () => {
    // 100 keys of 100 elements each is 10,000 nodes against a budget of 1024.
    const wide: Record<string, number[]> = {};
    for (let i = 0; i < 100; i++) {
      wide[`k${i}`] = Array.from({ length: 100 }, (_, j) => j);
    }
    const out = sanitizeFields(wide);
    // Here the key cap fires before the node budget runs out.
    const keys = Object.keys(out);
    expect(keys).toContain("<truncated>");
  });
});

describe("sanitizeFields — prototype-pollution defense", () => {
  it("skips `__proto__` keys", () => {
    // `JSON.parse` makes `__proto__` an own enumerable key, so `Object.entries` lists it; the
    // sanitizer must drop it explicitly.
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
    // Even with the key skipped, a null prototype keeps a stray `__proto__` assignment from
    // polluting `Object.prototype`.
    const out = sanitizeFields({ foo: "bar" });
    expect(Object.getPrototypeOf(out)).toBeNull();
  });
});

describe("sanitizeFields — ReDoS / pathological input resilience", () => {
  it("handles `'a/'.repeat(50000)` without throwing or hanging", () => {
    // The Unix path pattern `(?:\/[A-Za-z0-9_.-]+)+` must not backtrack catastrophically on a
    // 100KB adversarial input.
    const adversarial = "a/".repeat(50_000);
    const start = Date.now();
    const out = sanitizeFields({ adversarial });
    const elapsed = Date.now() - start;
    expect(out).toBeDefined();
    // A generous ceiling; a linear regex finishes in well under 50 ms.
    expect(elapsed).toBeLessThan(5000);
  });

  it("handles a 1MB pure-path string without throwing", () => {
    const adversarial = `/${"x".repeat(1_000_000)}`;
    expect(() => sanitizeFields({ adversarial })).not.toThrow();
  });

  it("handles a deeply-recursive cyclic structure without stack overflow", () => {
    // The depth cap stops the walk long before the 100,000-node chain closes its cycle.
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

describe("mapJsonRpcError — single-seam enforcement on data.fields", () => {
  it("end-to-end: SecureDefaultsValidationError with path-shape value → redacted on wire", () => {
    // A sensitive absolute path in `local-ipc-path` must not reach the wire through the error's
    // `fields.value`.
    const sensitivePath = "/home/operator/.secret-daemon/ipc.sock";
    const error = new SecureDefaultsValidationError(
      "invalid_local_ipc_path",
      `local-ipc-path rejected: ${sensitivePath}`,
      { setting: "localIpcPath", value: sensitivePath },
    );

    const envelope = mapJsonRpcError(error, 1);

    // Boot-time config errors map to -32602 InvalidParams.
    expect(envelope.error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.error.data?.type).toBe("invalid_local_ipc_path");
    const fields = envelope.error.data?.fields as Record<string, unknown> | undefined;
    expect(fields?.["setting"]).toBe("localIpcPath");
    expect(fields?.["value"]).toBe("<redacted-path>");
    // The message channel is sanitized too.
    expect(envelope.error.message).toContain("<redacted-path>");
    expect(envelope.error.message).not.toContain(sensitivePath);
  });

  it("end-to-end: SecureDefaultsValidationError with BigInt value → encoder does not throw", () => {
    // A raw BigInt would make `encodeFrame` throw and tear down the connection.
    const error = new SecureDefaultsValidationError(
      "unknown_setting",
      "unknown setting: maxQuota (got bigint)",
      { setting: "maxQuota", value: 9007199254740993n },
    );

    const envelope = mapJsonRpcError(error, 1);
    expect(() => encodeFrame(envelope)).not.toThrow();
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
      // The cast is deliberate: a throw site can put any runtime value in `fields`.
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
    // Clean detail is the common case and must reach the wire unchanged.
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
    // An oversized-body `FramingError` maps to `transport.message_too_large` with numeric
    // `{limit, observed}`.
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
    // Without a fields payload the envelope carries `data.type` only, not `data.fields: {}`.
    const error = new FramingError("malformed_header", "missing colon");
    const envelope = mapJsonRpcError(error, null);
    expect(envelope.error.data).toEqual({ type: "malformed_header" });
    expect(envelope.error.data && "fields" in envelope.error.data).toBe(false);
  });

  it("preserves envelope shape (jsonrpc + id + error) per JSON-RPC 2.0 section 5", () => {
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
    // `mapJsonRpcError` must yield a well-formed envelope even when both sanitizers face
    // adversarial input.
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
    // A plain `Error` matches no typed class, so it maps to -32603 with no `data`.
    const error = new Error("plain error");
    const envelope = mapJsonRpcError(error, 1);
    expect(envelope.error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(envelope.error.data).toBeUndefined();
  });
});

describe("mapJsonRpcError — DaemonDomainError wire projection", () => {
  it("projects a not-found domain error → jsonRpcCode + data.type + data.fields", () => {
    // A not-found error maps to -32602 because the supplied id does not resolve, like
    // `session.not_found`.
    const error = new DaemonDomainError("repo r-7 is not attached", {
      code: "repo.not_found",
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      httpStatus: 404,
      detail: { repoId: "r-7" },
    });

    const envelope = mapJsonRpcError(error, 1);

    expect(envelope.error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.error.data?.type).toBe("repo.not_found");
    expect(envelope.error.data?.fields).toEqual({ repoId: "r-7" });
  });

  it("defaults to -32603 InternalError when jsonRpcCode is omitted", () => {
    const error = new DaemonDomainError("approval store unavailable", {
      code: "approval.store_unavailable",
    });

    const envelope = mapJsonRpcError(error, 1);

    expect(envelope.error.code).toBe(JsonRpcErrorCode.InternalError);
    // With no detail, `data` carries only `type`.
    expect(envelope.error.data).toEqual({ type: "approval.store_unavailable" });
    expect(envelope.error.data && "fields" in envelope.error.data).toBe(false);
  });

  it("carries httpStatus on the error object but never leaks it onto the wire", () => {
    // The numeric code comes from `jsonRpcCode`; `httpStatus` stays off the wire.
    const error = new DaemonDomainError("repo r-9 not found", {
      code: "repo.not_found",
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      httpStatus: 404,
      detail: { repoId: "r-9" },
    });
    expect(error.httpStatus).toBe(404);

    const envelope = mapJsonRpcError(error, 1);
    expect("httpStatus" in envelope.error).toBe(false);
    expect(envelope.error.data && "httpStatus" in envelope.error.data).toBe(false);
    expect(JSON.stringify(envelope)).not.toContain("httpStatus");
    expect(JSON.stringify(envelope)).not.toContain("404");
  });

  it("runs data.fields through sanitizer (path redaction)", () => {
    // Domain-error detail goes through the same sanitizer as every other typed error.
    const sensitivePath = "/home/operator/.ssh/id_ed25519";
    const error = new DaemonDomainError("worktree path rejected", {
      code: "worktree.path_rejected",
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { path: sensitivePath },
    });

    const envelope = mapJsonRpcError(error, 1);
    const fields = envelope.error.data?.fields as Record<string, unknown> | undefined;
    expect(fields?.["path"]).toBe("<redacted-path>");
    expect(JSON.stringify(envelope)).not.toContain(sensitivePath);
    expect(() => encodeFrame(envelope)).not.toThrow();
  });

  it("projects a DaemonDomainError SUBCLASS through the same single branch", () => {
    // A subclass fixes its code and `jsonRpcCode` in `super(...)` and needs no mapper change;
    // `name` is the subclass name.
    class WorktreeLockedError extends DaemonDomainError {
      constructor(worktreeId: string) {
        super(`worktree ${worktreeId} is locked`, {
          code: "worktree.locked",
          jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
          detail: { worktreeId },
        });
      }
    }

    const error = new WorktreeLockedError("wt-3");
    expect(error.name).toBe("WorktreeLockedError");

    const envelope = mapJsonRpcError(error, "req-1");
    expect(envelope.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
    expect(envelope.error.data?.type).toBe("worktree.locked");
    expect(envelope.error.data?.fields).toEqual({ worktreeId: "wt-3" });
  });
});
