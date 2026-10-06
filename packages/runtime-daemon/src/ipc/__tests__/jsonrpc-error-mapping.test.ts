// `sanitizeFields` keeps filesystem paths and values the encoder cannot write out of an error's
// `data.fields`, within size caps, `sanitizeErrorMessage` never throws or passes its cap, and
// `mapJsonRpcError` puts every error on the wire through both.

import { describe, expect, it } from "vitest";

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import { encodeFrame } from "@ai-sidekicks/contracts/content-length-framing";

import { SecureDefaultsValidationError } from "../../bootstrap/secure-defaults.js";
import { DaemonDomainError } from "../domain-error.js";
import {
  mapJsonRpcError,
  sanitizeErrorMessage,
  SANITIZED_MESSAGE_MAX_LEN,
  sanitizeFields,
} from "../jsonrpc-error-mapping.js";

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

  it("keeps a slash inside a name, such as git's line refusing a branch", () => {
    const out = sanitizeFields({
      message: "fatal: 'feature/x y' is not a valid branch name; see /Users/me/repo",
    });
    expect(out).toEqual({
      message: "fatal: 'feature/x y' is not a valid branch name; see <redacted-path>",
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
});

describe("sanitizeFields — JSON-unsafe value normalization (DoS prevention)", () => {
  it("coerces BigInt values to canonical `${n}n` strings", () => {
    const out = sanitizeFields({ size: 9007199254740993n });
    expect(out).toEqual({ size: "9007199254740993n" });
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

  it("substitutes <truncated:circular> for self- and mutually referencing objects", () => {
    type Node = { name: string; self?: Node };
    const node: Node = { name: "root" };
    node.self = node;
    const out = sanitizeFields({ node });
    expect(out).toEqual({
      node: { name: "root", self: "<truncated:circular>" },
    });
    expect(() => JSON.stringify(out)).not.toThrow();

    type A = { kind: "a"; ref?: B };
    type B = { kind: "b"; ref?: A };
    const a: A = { kind: "a" };
    const b: B = { kind: "b", ref: a };
    a.ref = b;
    const mutualOut = sanitizeFields({ a });
    // The walk visits a, then b, then a again, which is the sentinel.
    expect(mutualOut).toEqual({
      a: {
        kind: "a",
        ref: { kind: "b", ref: "<truncated:circular>" },
      },
    });
    expect(() => JSON.stringify(mutualOut)).not.toThrow();
  });

  it("preserves shared sibling and array references as data, not <truncated:circular>", () => {
    // Siblings sharing a reference are not a cycle: the detector tracks the current recursion
    // path, not every value visited.
    const shared = { kind: "shared", payload: 42 };
    const out = sanitizeFields({ a: shared, b: shared });
    expect(out).toEqual({
      a: { kind: "shared", payload: 42 },
      b: { kind: "shared", payload: 42 },
    });
    expect(() => JSON.stringify(out)).not.toThrow();

    // The same holds for one object at several array indices.
    const sharedElement = { id: "s" };
    const listOut = sanitizeFields({ list: [sharedElement, sharedElement, sharedElement] });
    expect(listOut).toEqual({
      list: [{ id: "s" }, { id: "s" }, { id: "s" }],
    });
    expect(() => JSON.stringify(listOut)).not.toThrow();
  });

  it("substitutes <unsanitizeable> for objects whose Object.entries or a getter throws", () => {
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

    const hostileGetter = {
      get name() {
        throw new Error("getter trap");
      },
    };
    const getterOut = sanitizeFields({ hostile: hostileGetter });
    expect(getterOut).toEqual({ hostile: "<unsanitizeable>" });
    expect(() => JSON.stringify(getterOut)).not.toThrow();
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
});

describe("sanitizeFields — prototype-pollution defense", () => {
  it("skips `__proto__`, `constructor` and `prototype` keys into a null-prototype object", () => {
    // `JSON.parse` makes `__proto__` an own enumerable key, so `Object.entries` lists it; the
    // sanitizer must drop it explicitly.
    const fields = JSON.parse('{"__proto__": "evil", "real": "ok"}') as Record<string, unknown>;
    const out = sanitizeFields(fields);
    expect(out).toEqual({ real: "ok" });
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(false);

    const constructorFields = JSON.parse(
      '{"constructor": "evil1", "prototype": "evil2", "real": "ok"}',
    ) as Record<string, unknown>;
    expect(sanitizeFields(constructorFields)).toEqual({ real: "ok" });

    // Even with the key skipped, a null prototype keeps a stray `__proto__` assignment from
    // polluting `Object.prototype`.
    expect(Object.getPrototypeOf(sanitizeFields({ foo: "bar" }))).toBeNull();
  });
});

describe("sanitizeFields — ReDoS / pathological input resilience", () => {
  it("handles `'a/'.repeat(50000)` and a 1MB path without throwing or hanging", () => {
    // The Unix path pattern `(?:\/[A-Za-z0-9_.-]+)+` must not backtrack catastrophically on a
    // 100 KB `a/` run or a 1 MB path; a catastrophic case would hang into the test timeout.
    const adversarial = "a/".repeat(50_000);
    expect(() => sanitizeFields({ adversarial })).not.toThrow();

    const purePath = `/${"x".repeat(1_000_000)}`;
    expect(() => sanitizeFields({ adversarial: purePath })).not.toThrow();
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

  it("end-to-end: a BigInt or circular value in fields still encodes", () => {
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

    type Cycle = { name: string; self?: Cycle };
    const cycle: Cycle = { name: "rotated" };
    cycle.self = cycle;

    const circularError = new SecureDefaultsValidationError(
      "unknown_setting",
      "unknown setting: nested",
      // The cast is deliberate: a throw site can put any runtime value in `fields`.
      { setting: "nested", value: cycle as unknown },
    );

    const circularEnvelope = mapJsonRpcError(circularError, 1);
    expect(() => encodeFrame(circularEnvelope)).not.toThrow();
    const circularFields = circularEnvelope.error.data?.fields as
      | Record<string, unknown>
      | undefined;
    expect(circularFields?.["value"]).toEqual({
      name: "rotated",
      self: "<truncated:circular>",
    });
  });

  it("passes clean fields to the wire unchanged", () => {
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
      detail: { repoId: "r-7" },
    });

    const envelope = mapJsonRpcError(error, 1);

    expect(envelope.error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.error.data?.type).toBe("repo.not_found");
    expect(envelope.error.data?.fields).toEqual({ repoId: "r-7" });
  });
});

describe("sanitizeErrorMessage", () => {
  it("never throws and never exceeds its cap", () => {
    // It runs inside the reply path: a throw there would be an unhandled rejection, and an
    // uncapped message could make the reply too large to send.
    const poison = {
      toString(): string {
        throw new Error("toString-poison");
      },
    };
    expect(sanitizeErrorMessage(poison)).toBe("<unprintable thrown value>");
    const huge = sanitizeErrorMessage(new Error("x".repeat(SANITIZED_MESSAGE_MAX_LEN * 2)));
    expect(huge.length).toBeLessThanOrEqual(SANITIZED_MESSAGE_MAX_LEN);
  });
});
