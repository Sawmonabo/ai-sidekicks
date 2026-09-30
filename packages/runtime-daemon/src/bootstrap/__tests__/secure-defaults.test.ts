// Invalid config fails closed with a typed error, an insecure setting is refused on the wire,
// and each override event is emitted once per process. Both modules hold singleton state, so
// every case starts from a reset.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts";

import { mapJsonRpcError } from "../../ipc/jsonrpc-error-mapping.js";
import {
  SecureDefaultOverrideEmitter,
  type SecurityDefaultOverrideEvent,
  type SecurityDefaultOverrideSink,
} from "../secure-defaults-events.js";
import {
  SecureDefaults,
  SecureDefaultsValidationError,
  type SecureDefaultsConfig,
} from "../secure-defaults.js";

const VALID_BASE_CONFIG: SecureDefaultsConfig = {
  localIpcPath: "/tmp/ai-sidekicks-test.sock",
  bannerFormat: "text",
};

function makeOverrideEvent(
  behavior: number,
  overrides: Partial<SecurityDefaultOverrideEvent> = {},
): SecurityDefaultOverrideEvent {
  return {
    behavior,
    row: "7a",
    effective_value: "loopback_only",
    banner_printed_at: "2026-04-28T12:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  SecureDefaults.__resetForTest();
  SecureDefaultOverrideEmitter.__resetForTest();
});

afterEach(() => {
  SecureDefaults.__resetForTest();
  SecureDefaultOverrideEmitter.__resetForTest();
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

describe("single-emit-per-startup", () => {
  it("emits exactly once for a single behavior even when emit() is called twice", () => {
    const sink = vi.fn<SecurityDefaultOverrideSink>();
    SecureDefaultOverrideEmitter.setSink(sink);

    SecureDefaultOverrideEmitter.emit(makeOverrideEvent(1));
    SecureDefaultOverrideEmitter.emit(makeOverrideEvent(1));

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(makeOverrideEvent(1));
    expect(SecureDefaultOverrideEmitter.hasEmitted(1)).toBe(true);
  });

  it("emit() throws when no sink is installed and keeps the behavior's one event", () => {
    expect(SecureDefaultOverrideEmitter.hasSink()).toBe(false);
    expect(() => SecureDefaultOverrideEmitter.emit(makeOverrideEvent(1))).toThrow(
      /SecureDefaultOverrideEmitter\.setSink\(sink\) must be called before emit\(\)/,
    );
    // The failed emit must not use up the behavior's single event.
    expect(SecureDefaultOverrideEmitter.hasEmitted(1)).toBe(false);
  });
});
