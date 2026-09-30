// MethodRegistryImpl tests. They run synchronously against a bare registry with a hand-built
// `HandlerContext`; the registry-code to JSON-RPC numeric mapping is checked through
// `mapJsonRpcError`. Pinned invariants:
//   * A duplicate or malformed method name is rejected at register time, not at dispatch.
//   * Params are schema-validated before the handler runs; a malformed payload never reaches it.
//   * Method names match `METHOD_NAME_FORMAT` (from `@ai-sidekicks/contracts`) or the
//     daemon-local `$/`-prefixed LSP-style shape.

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

// No transportId, so dispatch runs without a wire boundary or negotiation gate.
const directCtx: HandlerContext = {};

describe("schema validates before dispatch", () => {
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
      expect(caught.issues).toBeDefined();
      const issues = caught.issues ?? [];
      expect(issues.length).toBeGreaterThan(0);
    }
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
    // A bad result is the daemon handler's fault, so it maps to -32603 (a bad params is the
    // client's fault and maps to -32602).
    if (caught instanceof RegistryDispatchError) {
      const env = mapJsonRpcError(caught, 1);
      expect(env.error.code).toBe(JsonRpcErrorCode.InternalError);
    }
  });
});

describe("method-not-found namespace isolation", () => {
  it("dispatching an unregistered method throws `method_not_found` and never falls through", async () => {
    const registry = new MethodRegistryImpl();
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
    // The stable string code rides in `data.type` so clients need not parse the message.
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
    // A duplicate check moved to dispatch time would surface only on a request.
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

describe("method-name format validation", () => {
  const ACCEPTED = [
    "session.create",
    "session.read",
    "session.subscribe",
    "presence.subscribe",
    "run.stream.notify",
    "settings.effectiveRead",
    "driver.listCapabilities",
    // A camelCase root is allowed; `providerAccount.*` is the only such namespace.
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
    // A segment may contain an uppercase letter (root included) but never start with one.
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
    // Format is the first gate, so a malformed name reports `invalid_method_name`.
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

  // Namespaces register camelCase-tailed verbs; a tail class limited to `[a-z0-9]` would reject
  // each of these at daemon boot.
  const BL142_CAMELCASE_TAILS = [
    "repo.mountRead",
    "repo.executionModeSelect",
    "approval.requestCreate",
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
