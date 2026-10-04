// MethodRegistryImpl: params are validated before the handler runs, a bad result or an unknown
// method is refused, each refusal maps to its JSON-RPC code, and a duplicate or malformed method
// name is rejected at register time.

import { describe, expect, it, vi } from "vitest";

import type { Handler, HandlerContext } from "@ai-sidekicks/contracts/jsonrpc-registry";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc";

import { mapJsonRpcError } from "../jsonrpc-error-mapping.js";
import {
  MethodRegistryImpl,
  RegistryDispatchError,
  RegistryRegistrationError,
} from "../registry.js";

import { passthroughSchema, rejectingSchema } from "../__fixtures__/zod-schemas.js";
import { captureRejection, captureThrow } from "../../__fixtures__/capture-failure.js";

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
    const caught = await captureRejection(
      registry.dispatch("math.sum", { bogus: true }, directCtx),
    );
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
    const caught = await captureRejection(registry.dispatch("math.sum", {}, directCtx));
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
    const caught = await captureRejection(registry.dispatch("not.registered", {}, directCtx));
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
    const caught = captureThrow(() =>
      registry.register(
        "math.sum",
        passthroughSchema<unknown>(),
        passthroughSchema<unknown>(),
        async () => undefined,
      ),
    );
    expect(caught).toBeInstanceOf(RegistryRegistrationError);
    if (caught instanceof RegistryRegistrationError) {
      expect(caught.registryCode).toBe("duplicate_method");
    }
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
    const registry = new MethodRegistryImpl();
    expect(() =>
      registry.register(name, passthroughSchema(), passthroughSchema(), async () => ({})),
    ).not.toThrow();
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
    const registry = new MethodRegistryImpl();
    expect(() =>
      registry.register(name, passthroughSchema(), passthroughSchema(), async () => ({})),
    ).toThrow(expect.objectContaining({ registryCode: "invalid_method_name" }));
  });
});
