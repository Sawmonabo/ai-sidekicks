// Binding before load throws, invalid config fails closed with a typed error, the settings view
// holds only its one key, and an insecure setting is refused on the wire. The module holds
// singleton state, so every case imports a fresh module graph.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";

import type { SecureDefaultsConfig } from "../secure-defaults.js";
import { captureThrow } from "../../__fixtures__/capture-failure.js";

const VALID_BASE_CONFIG: SecureDefaultsConfig = {
  localIpcPath: "/tmp/ai-sidekicks-test.sock",
};

type SecureDefaultsModule = typeof import("../secure-defaults.js");

let SecureDefaults: SecureDefaultsModule["SecureDefaults"];
let SecureDefaultsValidationError: SecureDefaultsModule["SecureDefaultsValidationError"];
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
  it("refuses a non-object and a missing key, each with its code, and stays unloaded", () => {
    // Unknown keys are covered by the refusal cases below.
    // The type rules this out; the runtime guard is what is pinned here.
    let caught = captureThrow(() => SecureDefaults.load(null as unknown as SecureDefaultsConfig));
    expect(caught).toBeInstanceOf(SecureDefaultsValidationError);
    if (!(caught instanceof SecureDefaultsValidationError)) return;
    expect(caught.code).toBe("invalid_config");
    expect(SecureDefaults.isLoaded()).toBe(false);
    expect(() => SecureDefaults.effectiveSettings()).toThrow();

    caught = captureThrow(() => SecureDefaults.load({} as unknown as SecureDefaultsConfig));
    expect(caught).toBeInstanceOf(SecureDefaultsValidationError);
    if (!(caught instanceof SecureDefaultsValidationError)) return;
    expect(caught.code).toBe("missing_required_setting");
    expect(caught.message).toMatch(/localIpcPath/);
    expect(SecureDefaults.isLoaded()).toBe(false);
  });
});

// The exact key set catches an added leaking field; the value round-trip catches a
// hard-coded constant.

describe("effectiveSettings non-secret typed values", () => {
  it("returns exactly the config key, carrying the loaded value", () => {
    bootstrap(VALID_BASE_CONFIG);
    const eff = SecureDefaults.effectiveSettings();

    expect(Object.keys(eff)).toEqual(["localIpcPath"]);

    expect(eff.localIpcPath).toBe("/tmp/ai-sidekicks-test.sock");
  });
});

// Any key outside the validation scope (`localIpcPath`) is refused with
// `unknown_setting`, both as the typed error and as the JSON-RPC envelope from
// `mapJsonRpcError`. The rest of the config is valid, so the key refusal is the only thing
// that can fire.

describe("unknown settings key refusal", () => {
  // Cast through `unknown` because the config type is closed and rejects these keys.
  const UNKNOWN_SETTINGS_KEYS: ReadonlyArray<string> = [
    "tlsMode",
    "tlsCertPath",
    "nonLoopbackHost",
    "firstRunKeysPolicy",
  ];

  it.each(UNKNOWN_SETTINGS_KEYS)("refuses key %p with `unknown_setting` envelope", (unknownKey) => {
    const config = {
      ...VALID_BASE_CONFIG,
      [unknownKey]: "any-value",
    } as unknown as SecureDefaultsConfig;

    const caught = captureThrow(() => SecureDefaults.load(config));

    expect(caught).toBeInstanceOf(SecureDefaultsValidationError);
    if (!(caught instanceof SecureDefaultsValidationError)) return;
    expect(caught.code).toBe("unknown_setting");
    expect(caught.message).toMatch(new RegExp(unknownKey));

    // Boot-time config counts as request params, so the code is InvalidParams.
    const envelope = mapJsonRpcError(caught, 1);
    expect(envelope.error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.error.data).toEqual({
      type: "unknown_setting",
      fields: { setting: unknownKey, value: "any-value" },
    });

    expect(SecureDefaults.isLoaded()).toBe(false);
  });
});
