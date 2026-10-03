// Binding before load throws, invalid config fails closed with a typed error, the settings view
// holds only its two keys, and an insecure setting is refused on the wire. The module holds
// singleton state, so every case imports a fresh module graph.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts";

import type { SecureDefaultsConfig } from "../secure-defaults.js";

const VALID_BASE_CONFIG: SecureDefaultsConfig = {
  localIpcPath: "/tmp/ai-sidekicks-test.sock",
  bannerFormat: "text",
};

let SecureDefaults: typeof import("../secure-defaults.js").SecureDefaults;
let SecureDefaultsValidationError: typeof import("../secure-defaults.js").SecureDefaultsValidationError;
let assertLoadedForBind: typeof import("../index.js").assertLoadedForBind;
let bootstrap: typeof import("../index.js").bootstrap;
let mapJsonRpcError: typeof import("../../ipc/jsonrpc-error-mapping.js").mapJsonRpcError;

beforeEach(async () => {
  // The mapper's `instanceof` must see the same class the case throws, so all three come from
  // one fresh graph.
  vi.resetModules();
  ({ SecureDefaults, SecureDefaultsValidationError } = await import("../secure-defaults.js"));
  ({ assertLoadedForBind, bootstrap } = await import("../index.js"));
  ({ mapJsonRpcError } = await import("../../ipc/jsonrpc-error-mapping.js"));
});

describe("load-before-bind", () => {
  it("assertLoadedForBind() throws when called before SecureDefaults.load()", () => {
    expect(SecureDefaults.isLoaded()).toBe(false);
    expect(() => assertLoadedForBind()).toThrow(
      /SecureDefaults\.load\(config\) must complete before any listener bind\(\)/,
    );
  });
});

// The typed error and its stable `code` are what callers key on, so each case checks the
// class and code rather than a message regex, and checks that the failed load left nothing
// loaded.
describe("fail-closed on invalid config", () => {
  it("refuses a bad value, a non-object and a missing key, each with its code, and stays unloaded", () => {
    let caught: unknown;
    try {
      // Per-field validation; unknown keys are covered by the extended-scope cases below.
      SecureDefaults.load({
        ...VALID_BASE_CONFIG,
        bannerFormat: "yaml",
      } as unknown as SecureDefaultsConfig);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SecureDefaultsValidationError);
    if (!(caught instanceof SecureDefaultsValidationError)) return;
    expect(caught.code).toBe("invalid_banner_format");
    // The message names the offending value and the allowed set.
    expect(caught.message).toMatch(/yaml/);
    expect(caught.message).toMatch(/\["text", "json"\]/);
    expect(SecureDefaults.isLoaded()).toBe(false);
    expect(() => SecureDefaults.effectiveSettings()).toThrow();

    caught = undefined;
    try {
      // The type rules this out; the runtime guard is what is pinned here.
      SecureDefaults.load(null as unknown as SecureDefaultsConfig);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SecureDefaultsValidationError);
    if (!(caught instanceof SecureDefaultsValidationError)) return;
    expect(caught.code).toBe("invalid_config");
    expect(SecureDefaults.isLoaded()).toBe(false);

    caught = undefined;
    try {
      SecureDefaults.load({
        localIpcPath: "/tmp/ai-sidekicks-test.sock",
      } as unknown as SecureDefaultsConfig);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SecureDefaultsValidationError);
    if (!(caught instanceof SecureDefaultsValidationError)) return;
    expect(caught.code).toBe("missing_required_setting");
    expect(caught.message).toMatch(/bannerFormat/);
    expect(SecureDefaults.isLoaded()).toBe(false);
  });
});

// The exact key set catches an added leaking field; the value round-trip catches a
// hard-coded constant.

describe("effectiveSettings non-secret typed values", () => {
  it("returns exactly the two config keys, each carrying the loaded value", () => {
    bootstrap(VALID_BASE_CONFIG);
    const eff = SecureDefaults.effectiveSettings();

    // Sorted, so the order of the returned literal does not matter.
    expect(Object.keys(eff).sort()).toEqual(["bannerFormat", "localIpcPath"]);

    expect(eff.localIpcPath).toBe("/tmp/ai-sidekicks-test.sock");
    expect(eff.bannerFormat).toBe("text");
  });
});

// Each extended-scope key must be refused with `unknown_setting`, both as the typed error
// and as the JSON-RPC envelope from `mapJsonRpcError`. The rest of the config is valid, so
// the key refusal is the only thing that can fire.

describe("extended-scope-key refusal", () => {
  // Cast through `unknown` because the config type is closed and rejects these keys.
  const EXTENDED_SCOPE_KEYS: ReadonlyArray<string> = [
    "tlsMode",
    "tlsCertPath",
    "nonLoopbackHost",
    "firstRunKeysPolicy",
  ];

  it.each(EXTENDED_SCOPE_KEYS)(
    "refuses key %p with `unknown_setting` envelope",
    (extendedScopeKey) => {
      const config = {
        ...VALID_BASE_CONFIG,
        [extendedScopeKey]: "any-value",
      } as unknown as SecureDefaultsConfig;

      let caught: unknown;
      try {
        SecureDefaults.load(config);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(SecureDefaultsValidationError);
      if (!(caught instanceof SecureDefaultsValidationError)) return;
      expect(caught.code).toBe("unknown_setting");
      expect(caught.message).toMatch(new RegExp(extendedScopeKey));

      // Boot-time config counts as request params, so the code is InvalidParams.
      const envelope = mapJsonRpcError(caught, 1);
      expect(envelope.error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(envelope.error.data).toEqual({
        type: "unknown_setting",
        fields: { setting: extendedScopeKey, value: "any-value" },
      });

      expect(SecureDefaults.isLoaded()).toBe(false);
    },
  );
});
