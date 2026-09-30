// MethodRegistryImpl: params are validated before the handler runs, a bad result or an unknown
// method is refused, each refusal maps to its JSON-RPC code, and a duplicate method is rejected at
// register time.

import { describe, expect, it, vi } from "vitest";

import type { Handler, HandlerContext } from "@ai-sidekicks/contracts";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts";

import { mapJsonRpcError } from "../jsonrpc-error-mapping.js";
import {
  MethodRegistryImpl,
  RegistryDispatchError,
  RegistryRegistrationError,
} from "../registry.js";

import { passthroughSchema, rejectingSchema } from "./__fixtures__/zod-schemas.js";

// No transportId, so dispatch runs without a wire boundary or negotiation gate.
const directCtx: HandlerContext = {};

describe("schema validates before dispatch", () => {
  it("malformed params throw `invalid_params`, mapped to -32602; handler is NEVER invoked", async () => {
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

    const envelope = mapJsonRpcError(caught, 1);
    expect(envelope.error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.id).toBe(1);
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
  it("dispatching an unregistered method throws `method_not_found`, mapped to -32601", async () => {
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

    const envelope = mapJsonRpcError(caught, 7);
    expect(envelope.error.code).toBe(JsonRpcErrorCode.MethodNotFound);
    expect(envelope.id).toBe(7);
    // The stable string code rides in `data.type` so clients need not parse the message.
    expect(envelope.error.data).toEqual({ type: "method_not_found" });
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
});
