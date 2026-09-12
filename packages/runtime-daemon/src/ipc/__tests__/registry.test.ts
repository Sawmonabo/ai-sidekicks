// W-007p-2-T7 + T9 — MethodRegistryImpl test suite.
//
// Invariants verified here (canonical text):
//   * Duplicate method-name registration MUST be rejected at
//     register-time (synchronous), not at dispatch-time.
//   * Schema validation runs BEFORE handler dispatch. Handler is NEVER
//     invoked on a malformed payload — `safeParse` short- circuits
//     dispatch with `RegistryDispatchError("invalid_params")`.
//   * Method names conform to the canonical regex set (every segment
//     starts lowercase and may carry camelCase, the namespace root
//     included since the 2026-09-05 root widening): `METHOD_NAME_FORMAT`
//     (the single source exported from `@ai-sidekicks/contracts`,
//     canonical) ∪ `METHOD_NAME_LSP_REGEX` (daemon-local LSP-style
//     `$/`-prefixed; separate follow-up).
//
//   * W-007p-2-T7 — Method-not-found namespace-isolation. Invoking an
//                   `not.registered`) returns
//                   `RegistryDispatchError("method_not_found")` which
//                   maps to JSON-RPC `-32601`.
//   * W-007p-2-T9 — Schema-validates-before-dispatch. Malformed payload
//                   throws `RegistryDispatchError("invalid_params")`
//                   (mapping to JSON-RPC `-32602`); handler is NEVER
//                   invoked.
//
// The registry tests run synchronously without binding any listener —
// dispatch is a direct method call against the registry instance with a
// hand-built `HandlerContext`. The wire-side mapping (registry-code →
// JSON-RPC numeric) is verified via `mapJsonRpcError` (also synchronous).

import { describe, expect, it, vi } from "vitest";

import type { Handler, HandlerContext } from "@ai-sidekicks/contracts";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts";

import { mapJsonRpcError } from "../jsonrpc-error-mapping.js";
import {
  isCanonicalMethodName,
  MethodRegistryImpl,
  RegistryDispatchError,
  RegistryRegistrationError,
} from "../registry.js";

import { passthroughSchema, rejectingSchema } from "./__fixtures__/zod-schemas.js";

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

/**
 * The minimal `HandlerContext` for direct dispatch — no transportId so
 * the registry path runs without a wire boundary. The negotiation gate
 * is wrapped over the registry separately (see protocol-negotiation
 * test suite); this file exercises the bare registry surface only.
 */
const directCtx: HandlerContext = {};

// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------

describe("W-007p-2-T9 — schema validates before dispatch", () => {
  it("malformed params throw `invalid_params`; handler is NEVER invoked", async () => {
    const registry = new MethodRegistryImpl();
    const handler = vi.fn<(p: unknown, c: HandlerContext) => Promise<unknown>>(async () => ({
      ok: true,
    }));
    registry.register(
      "math.sum",
      rejectingSchema<unknown>("malformed-sum-params"),
      passthroughSchema<unknown>(),
      handler,
    );
    let caught: unknown = null;
    try {
      await registry.dispatch("math.sum", { bogus: true }, directCtx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("invalid_params");
      // The issues array carries the schema's failure marker — useful
      // for downstream observability.
      expect(caught.issues).toBeDefined();
      const issues = caught.issues ?? [];
      expect(issues.length).toBeGreaterThan(0);
    }
    // Critical assertion — the handler must NEVER have run.
    expect(handler).not.toHaveBeenCalled();
  });

  it("`invalid_params` registry code maps to JSON-RPC `-32602` on the wire", () => {
    const err = new RegistryDispatchError("invalid_params", "params validation failed", [
      { marker: "test" },
    ]);
    const envelope = mapJsonRpcError(err, 1);
    expect(envelope.error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.id).toBe(1);
  });

  it("dispatches successfully when params pass validation, returning the handler's result", async () => {
    const registry = new MethodRegistryImpl();
    const handler: Handler<{ a: number; b: number }, { sum: number }> = async (params) => {
      return { sum: params.a + params.b };
    };
    registry.register(
      "math.sum",
      passthroughSchema<{ a: number; b: number }>(),
      passthroughSchema<{ sum: number }>(),
      handler,
    );
    const result = await registry.dispatch("math.sum", { a: 3, b: 4 }, directCtx);
    expect(result).toStrictEqual({ sum: 7 });
  });

  it("`invalid_result` (handler returns malformed data) throws and maps to `-32603` (programmer error)", async () => {
    const registry = new MethodRegistryImpl();
    const handler: Handler<unknown, unknown> = async () => ({ wrong: "shape" });
    registry.register(
      "math.sum",
      passthroughSchema<unknown>(),
      rejectingSchema<unknown>("invalid-result-shape"),
      handler,
    );
    let caught: unknown = null;
    try {
      await registry.dispatch("math.sum", {}, directCtx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("invalid_result");
    }
    // Wire-mapping side: -32603 InternalError because the daemon's
    // handler is at fault (the asymmetry in jsonrpc-error-mapping.ts
    // lines 218-228 — params blames the client; result blames the
    // daemon).
    if (caught instanceof RegistryDispatchError) {
      const env = mapJsonRpcError(caught, 1);
      expect(env.error.code).toBe(JsonRpcErrorCode.InternalError);
    }
  });
});

// ----------------------------------------------------------------------------
// W-007p-2-T7 — method-not-found namespace isolation
// ----------------------------------------------------------------------------

describe("W-007p-2-T7 — method-not-found namespace isolation", () => {
  it("dispatching an unregistered method throws `method_not_found` and never falls through", async () => {
    const registry = new MethodRegistryImpl();
    // Register a different method so the registry isn't empty.
    registry.register(
      "math.sum",
      passthroughSchema<unknown>(),
      passthroughSchema<unknown>(),
      async () => undefined,
    );
    let caught: unknown = null;
    try {
      await registry.dispatch("not.registered", {}, directCtx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistryDispatchError);
    if (caught instanceof RegistryDispatchError) {
      expect(caught.registryCode).toBe("method_not_found");
    }
  });

  it("`method_not_found` registry code maps to JSON-RPC `-32601` on the wire", () => {
    const err = new RegistryDispatchError(
      "method_not_found",
      "method `not.registered` is not registered",
    );
    const envelope = mapJsonRpcError(err, 7);
    expect(envelope.error.code).toBe(JsonRpcErrorCode.MethodNotFound);
    expect(envelope.id).toBe(7);
    // Two-layer envelope): the registry's stable string code projects
    // into `data.type` so downstream observability can discriminate on
    // the canonical project identifier without parsing the
    // human-readable message.
    expect(envelope.error.data).toEqual({ type: "method_not_found" });
  });

  it("`has(method)` returns true for registered names and false for unregistered", () => {
    const registry = new MethodRegistryImpl();
    registry.register(
      "x.y",
      passthroughSchema<unknown>(),
      passthroughSchema<unknown>(),
      async () => undefined,
    );
    expect(registry.has("x.y")).toBe(true);
    expect(registry.has("not.registered")).toBe(false);
  });

  it("`isMutating` discriminates registered/unregistered + read/write", () => {
    const registry = new MethodRegistryImpl();
    registry.register(
      "math.read",
      passthroughSchema<unknown>(),
      passthroughSchema<unknown>(),
      async () => undefined,
    );
    registry.register(
      "math.write",
      passthroughSchema<unknown>(),
      passthroughSchema<unknown>(),
      async () => undefined,
      { mutating: true },
    );
    expect(registry.isMutating("math.read")).toBe(false);
    expect(registry.isMutating("math.write")).toBe(true);
    expect(registry.isMutating("not.registered")).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// Duplicate-method registration rejected at register-time
// ----------------------------------------------------------------------------

describe("duplicate method registration rejected at register-time", () => {
  it("registering the same method twice throws `RegistryRegistrationError(`duplicate_method`)`", () => {
    const registry = new MethodRegistryImpl();
    registry.register(
      "math.sum",
      passthroughSchema<unknown>(),
      passthroughSchema<unknown>(),
      async () => undefined,
    );
    let caught: unknown = null;
    try {
      registry.register(
        "math.sum",
        passthroughSchema<unknown>(),
        passthroughSchema<unknown>(),
        async () => undefined,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistryRegistrationError);
    if (caught instanceof RegistryRegistrationError) {
      expect(caught.registryCode).toBe("duplicate_method");
    }
  });

  it("the duplicate throw is SYNCHRONOUS (no async / no dispatch needed)", () => {
    // Fail-fast verification — a regression that moved the duplicate
    // check into dispatch-time would surface only on a request.
    const registry = new MethodRegistryImpl();
    registry.register(
      "x.y",
      passthroughSchema<unknown>(),
      passthroughSchema<unknown>(),
      async () => undefined,
    );
    expect(() => {
      registry.register(
        "x.y",
        passthroughSchema<unknown>(),
        passthroughSchema<unknown>(),
        async () => undefined,
      );
    }).toThrow(RegistryRegistrationError);
  });
});

// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------

describe("method-name format validation", () => {
  // Exhaustive each-table over the dotted-camelCase + LSP-style accepts.
  const ACCEPTED = [
    "session.create",
    "session.read",
    "session.subscribe",
    "presence.subscribe",
    "run.stream.notify",
    "settings.effectiveRead",
    "driver.listCapabilities",
    // camelCase ROOT — admitted by the 2026-09-05 first-segment widening in
    // that same ratification. `providerAccount.*` is the corpus's only
    // camelCase-rooted namespace; every one of its verbs threw here before.
    "providerAccount.list",
    "$/subscription/notify",
    "$/subscription/cancel",
    "$/cancelRequest",
    "daemon.hello",
  ];
  it.each(ACCEPTED)("accepts canonical name `%s`", (name) => {
    expect(isCanonicalMethodName(name)).toBe(true);
  });

  const REJECTED = [
    // No segment may START uppercase. The 2026-09-05 root widening admits an
    // uppercase letter INSIDE a segment — root included — and never at its head,
    // so these two are the guard that it did not loosen further than that.
    "Session.create", // uppercase-starting root
    "ProviderAccount.list", // uppercase-starting root of the widened namespace
    "sessionCreate", // no dot
    "session/create", // slash separator (non-LSP)
    "session.", // trailing dot
    ".create", // leading dot
    "$cancel", // no slash
    "/subscribe", // no dollar
    "$//notify", // empty segment
    "$/Subscription/notify", // uppercase head after $/
  ];
  it.each(REJECTED)("rejects malformed name `%s`", (name) => {
    expect(isCanonicalMethodName(name)).toBe(false);
  });

  it("registering a malformed method-name throws `RegistryRegistrationError(`invalid_method_name`)`", () => {
    const registry = new MethodRegistryImpl();
    let caught: unknown = null;
    try {
      registry.register(
        "Session.create", // uppercase head — rejected
        passthroughSchema<unknown>(),
        passthroughSchema<unknown>(),
        async () => undefined,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistryRegistrationError);
    if (caught instanceof RegistryRegistrationError) {
      expect(caught.registryCode).toBe("invalid_method_name");
    }
  });

  it("the format check runs BEFORE the duplicate check (regex first per registry.ts:298-315)", () => {
    // A malformed name that "duplicates" itself should still throw with
    // `invalid_method_name`, not `duplicate_method` — the format check
    // is the first gate.
    const registry = new MethodRegistryImpl();
    let caught: unknown = null;
    try {
      registry.register(
        "Bad.Name",
        passthroughSchema<unknown>(),
        passthroughSchema<unknown>(),
        async () => undefined,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistryRegistrationError);
    if (caught instanceof RegistryRegistrationError) {
      expect(caught.registryCode).toBe("invalid_method_name");
    }
  });

  // The deployed registry regex must accept the camelCase-tailed method
  // strings the Tier-6/7 namespace plans register. Before the tail- class fix
  // (`[a-z0-9]` → `[a-zA-Z0-9]`), every one threw
  // `RegistryRegistrationError("invalid_method_name")` at daemon boot,
  // blocking 010/012/016 Phase 3 registrations. Each pairs a lowercase root
  // with a camelCase tail per the canonical `METHOD_NAME_FORMAT`, whose
  // 2026-09-05 root widening additionally admits a camelCase root such as
  // `providerAccount.list`.
  const BL142_CAMELCASE_TAILS = [
    "repo.mountRead",
    "repo.executionModeSelect",
    "approval.requestCreate",
    "channel.rosterRead",
    "orchestration.runCreate",
    "orchestration.childRunLinkRead",
    "orchestration.budgetRead",
    "orchestration.budgetUpdate",
    "agent.configUpdate",
  ];
  it.each(BL142_CAMELCASE_TAILS)(
    "accepts camelCase-tailed V1 method name `%s` (unblock)",
    (name) => {
      expect(isCanonicalMethodName(name)).toBe(true);
    },
  );

  it("registers a camelCase-tailed method without throwing (end-to-end)", () => {
    const registry = new MethodRegistryImpl();
    expect(() => {
      registry.register(
        "repo.mountRead",
        passthroughSchema<unknown>(),
        passthroughSchema<unknown>(),
        async () => undefined,
      );
    }).not.toThrow();
  });
});
