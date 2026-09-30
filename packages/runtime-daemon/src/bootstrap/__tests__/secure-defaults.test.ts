// Bootstrap guards: reading settings or binding before `load` throws, invalid config fails
// closed with a typed error that also projects to the JSON-RPC envelope, and each override
// event is emitted once per process. Both modules hold singleton state, so every case starts
// from a reset.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts";

import { mapJsonRpcError } from "../../ipc/jsonrpc-error-mapping.js";
import { bootstrap, assertLoadedForBind } from "../index.js";
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

// The read guard and the bind guard are separate cases so a fix to one cannot hide the other.
describe("load-before-bind", () => {
  it("SecureDefaults.effectiveSettings() throws when called before load() (API-internal guard)", () => {
    expect(SecureDefaults.isLoaded()).toBe(false);
    expect(() => SecureDefaults.effectiveSettings()).toThrow(
      /SecureDefaults\.load\(config\) must succeed before this view is read/,
    );
  });

  it("assertLoadedForBind() throws when called before bootstrap()/SecureDefaults.load() (orchestrator-throw)", () => {
    expect(SecureDefaults.isLoaded()).toBe(false);
    expect(() => assertLoadedForBind()).toThrow(
      /SecureDefaults\.load\(config\) must complete before any listener bind\(\)/,
    );
  });

  it("after bootstrap() succeeds, both surfaces stop throwing (proves the guard release path is wired)", () => {
    bootstrap(VALID_BASE_CONFIG);
    expect(SecureDefaults.isLoaded()).toBe(true);
    expect(() => SecureDefaults.effectiveSettings()).not.toThrow();
    expect(() => assertLoadedForBind()).not.toThrow();
  });
});

// The typed error and its stable `code` are what callers key on, so each case checks the
// class and code rather than a message regex, and checks that the failed load left nothing
// loaded.
describe("fail-closed on invalid config", () => {
  it("throws SecureDefaultsValidationError with an actionable message and leaves isLoaded()===false", () => {
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
  });

  it("rejects a non-object config with code='invalid_config' (rules out partial start on top-level bad input)", () => {
    let caught: unknown;
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
  });

  it("rejects missing required keys with code='missing_required_setting' and stays unloaded", () => {
    let caught: unknown;
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

    expect(Object.isFrozen(eff)).toBe(true);
  });

  it("admits the json banner format end-to-end", () => {
    bootstrap({ ...VALID_BASE_CONFIG, bannerFormat: "json" });
    const eff = SecureDefaults.effectiveSettings();
    expect(eff.bannerFormat).toBe("json");
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

  it("refuses a config carrying multiple extended-scope keys at once (refuse-unknown-keys catches the first encountered)", () => {
    // Several bad keys surface one `unknown_setting`; which key is named follows object
    // key order, so only membership is asserted.
    const config = {
      ...VALID_BASE_CONFIG,
      tlsMode: "strict",
      nonLoopbackHost: "0.0.0.0",
      firstRunKeysPolicy: "auto",
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

    const envelope = mapJsonRpcError(caught, 1);
    expect(envelope.error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.error.data?.type).toBe("unknown_setting");
    const fields = envelope.error.data?.fields as Record<string, unknown> | undefined;
    expect(fields?.["setting"]).toMatch(/^(tlsMode|nonLoopbackHost|firstRunKeysPolicy)$/);
  });
});

// Dedupe is per `behavior`; a throwing sink must not let a retry produce a second event.

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

  it("emits independently for two distinct behaviors, each exactly once", () => {
    const sink = vi.fn<SecurityDefaultOverrideSink>();
    SecureDefaultOverrideEmitter.setSink(sink);

    SecureDefaultOverrideEmitter.emit(makeOverrideEvent(1));
    SecureDefaultOverrideEmitter.emit(makeOverrideEvent(2));
    SecureDefaultOverrideEmitter.emit(makeOverrideEvent(1));
    SecureDefaultOverrideEmitter.emit(makeOverrideEvent(2));

    expect(sink).toHaveBeenCalledTimes(2);
    const behaviorsCalled = sink.mock.calls.map((call) => call[0].behavior).sort();
    expect(behaviorsCalled).toEqual([1, 2]);
    expect(SecureDefaultOverrideEmitter.hasEmitted(1)).toBe(true);
    expect(SecureDefaultOverrideEmitter.hasEmitted(2)).toBe(true);
  });

  it("mark-before-fire: a sink that throws still marks the behavior; a retry with a counting sink does NOT produce a duplicate", () => {
    const throwingSink: SecurityDefaultOverrideSink = () => {
      throw new Error("simulated sink failure");
    };
    SecureDefaultOverrideEmitter.setSink(throwingSink);

    expect(() => SecureDefaultOverrideEmitter.emit(makeOverrideEvent(1))).toThrow(
      /simulated sink failure/,
    );

    // Marked before the sink ran; marking after would leave this false.
    expect(SecureDefaultOverrideEmitter.hasEmitted(1)).toBe(true);

    // Replacing the sink keeps the dedupe state.
    const countingSink = vi.fn<SecurityDefaultOverrideSink>();
    SecureDefaultOverrideEmitter.setSink(countingSink);

    SecureDefaultOverrideEmitter.emit(makeOverrideEvent(1));

    // The retry was suppressed even though the first delivery failed.
    expect(countingSink).toHaveBeenCalledTimes(0);
  });

  it("emit() throws when no sink is installed (symmetric pre-condition guard)", () => {
    expect(SecureDefaultOverrideEmitter.hasSink()).toBe(false);
    expect(() => SecureDefaultOverrideEmitter.emit(makeOverrideEvent(1))).toThrow(
      /SecureDefaultOverrideEmitter\.setSink\(sink\) must be called before emit\(\)/,
    );
    // The failed emit must not use up the behavior's single event.
    expect(SecureDefaultOverrideEmitter.hasEmitted(1)).toBe(false);
  });
});
