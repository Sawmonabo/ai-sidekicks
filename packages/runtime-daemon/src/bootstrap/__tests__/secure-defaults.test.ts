// W-007p-1-T1..T5 — SecureDefaults bootstrap test suite (T-007p-1-4).
//
// Covers all five Plan-007 §Invariants the Tier-1 SecureDefaults +
// override-emitter substrate enforces:
//
//   * I-007-1 (load-before-bind, T1): pre-load `SecureDefaults.effectiveSettings()`
//     and `assertLoadedForBind()` BOTH throw. Two assertion sites because the
//     plan calls out the "API-internal guard" (effectiveSettings) AND the
//     orchestrator-throw (assertLoadedForBind) as distinct enforcement
//     surfaces; a regression that fixed one but not the other would leak past
//     a single-site test.
//   * I-007-2 (fail-closed, T2): invalid config throws `SecureDefaultsValidationError`
//     with an actionable message AND leaves `isLoaded() === false` — there
//     is no partial-start state.
//   * I-007-3 (effectiveSettings non-secret, T3): the returned object has
//     EXACTLY the four conservative-config keys (`bindAddress`, `bindPort`,
//     `localIpcPath`, `bannerFormat`); no extras leak through.
//     `bindPort` is OMITTED (not `undefined`-assigned) when the input
//     omits it — this matches the source's `exactOptionalPropertyTypes`
//     branch on lines 353-365 of secure-defaults.ts and is what
//     downstream consumers will key on.
//   * I-007-5 (Tier-4-scope-key refusal, T4): each of `tlsMode`,
//     `tlsCertPath`, `nonLoopbackHost`, `firstRunKeysPolicy` is refused
//     with the `unknown_setting` error code AND the canonical two-layer
//     JSON-RPC envelope per error-contracts.md §JSON-RPC Wire Mapping
//     (BL-103 closed 2026-05-01) — `error.code === -32602
//     InvalidParams`, `error.data === { type: "unknown_setting",
//     fields: { setting, value } }`. T4 asserts source-side (typed
//     error class + stable string code) AND wire-side (envelope shape
//     via `mapJsonRpcError`) so a regression on either projection seam
//     fails the test.
//   * I-007-4 (single-emit-per-startup, T5): the `SecureDefaultOverrideEmitter`
//     fires each `behavior` integer exactly once across the process
//     lifetime; two distinct behaviors each emit independently; AND the
//     mark-before-fire ordering (source lines 209-215 of
//     secure-defaults-events.ts) means a sink that throws does NOT
//     allow a retry to produce a duplicate emission for the same
//     behavior.
//
// Reset discipline: every `it()` runs in a `beforeEach` that calls
// `SecureDefaults.__resetForTest()` AND
// `SecureDefaultOverrideEmitter.__resetForTest()`. Vitest shares the
// Node process across cases, and both modules expose mutable
// module-singleton state; without the reset, the load-state from one
// test would poison the next (e.g. T1's "pre-load throws" would
// silently pass after T2 had already loaded a valid config).

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

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

// The minimal valid config for the Tier 1 conservative-config shape
// (matches secure-defaults.ts inline contract). bindPort is OMITTED
// here so the default fixture exercises the "without bindPort" branch
// of validation; tests that need bindPort spread in their own.
const VALID_BASE_CONFIG: SecureDefaultsConfig = {
  bindAddress: "127.0.0.1",
  localIpcPath: "/tmp/ai-sidekicks-test.sock",
  bannerFormat: "text",
};

// A representative override event for the I-007-4 dedupe assertions.
// The `behavior` integer is what the dedupe Set keys on; `row`,
// `effective_value`, and `banner_printed_at` are payload-shape fields
// per Spec-027:138 carried verbatim through the sink.
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

// ----------------------------------------------------------------------------
// Per-test reset
// ----------------------------------------------------------------------------

beforeEach(() => {
  // Mandatory reset of BOTH module singletons. See file-header reset-
  // discipline note for why: vitest shares the Node process across
  // cases, so any prior `SecureDefaults.load(...)` or
  // `SecureDefaultOverrideEmitter.setSink(...)` would leak forward.
  SecureDefaults.__resetForTest();
  SecureDefaultOverrideEmitter.__resetForTest();
});

afterEach(() => {
  // Belt-and-braces: also reset on the way out so the next test file
  // (or a stray side-effect from a future addition here) starts from
  // a clean state. The reset is idempotent and cheap.
  SecureDefaults.__resetForTest();
  SecureDefaultOverrideEmitter.__resetForTest();
});

// ----------------------------------------------------------------------------
// W-007p-1-T1 — I-007-1 load-before-bind
// ----------------------------------------------------------------------------
//
// Two sibling `it()`s assert the two enforcement surfaces named in the
// plan: the API-internal guard (`SecureDefaults.effectiveSettings()`)
// AND the orchestrator-throw (`assertLoadedForBind()`). Splitting them
// preserves diagnostic precision — a regression that fixes one but not
// the other surfaces as a single failed `it()` rather than a generic
// "load-before-bind broke" message.

describe("W-007p-1-T1 (I-007-1: load-before-bind)", () => {
  it("SecureDefaults.effectiveSettings() throws when called before load() (API-internal guard)", () => {
    // The constructor-throw on `new SecureDefaults()` is a separate
    // guard. Here we want the load-before-read throw on the static
    // accessor, NOT the instantiation guard.
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
    // Belt-and-braces: pin the success path on the same module-state
    // axis so a regression that broke `isLoaded()` (e.g. by no-op'ing
    // `loadedSettings` assignment) would also surface here.
    bootstrap(VALID_BASE_CONFIG);
    expect(SecureDefaults.isLoaded()).toBe(true);
    expect(() => SecureDefaults.effectiveSettings()).not.toThrow();
    expect(() => assertLoadedForBind()).not.toThrow();
  });
});

// ----------------------------------------------------------------------------
// W-007p-1-T2 — I-007-2 fail-closed on invalid config
// ----------------------------------------------------------------------------
//
// Plan §Invariants: "the daemon MUST refuse to start with a typed
// error". The "typed error" wording is load-bearing: a regression that
// threw a generic `Error("config bad")` would still match a
// `toThrow(string)` assertion but would lose the structured `.code`
// downstream consumers (and the C-7 envelope, when it lands) key on.
// Hence `try/catch` + `toBeInstanceOf(SecureDefaultsValidationError)`
// + `caught.code === "<expected>"` rather than a regex shortcut.
//
// "No partial-start path" surfaces as `isLoaded() === false` AFTER
// the failed first-time `load()` — the side-effect witness for
// fail-closed.

describe("W-007p-1-T2 (I-007-2: fail-closed on invalid config)", () => {
  it("throws SecureDefaultsValidationError with an actionable message and leaves isLoaded()===false", () => {
    let caught: unknown;
    try {
      // Invalid bindAddress: not in the loopback set. This exercises
      // the per-field validation path (vs the refuse-unknown-keys
      // path covered by T4); both fail-modes share the
      // SecureDefaultsValidationError type, so this case is a
      // representative witness.
      SecureDefaults.load({
        ...VALID_BASE_CONFIG,
        bindAddress: "0.0.0.0",
      });
    } catch (err) {
      caught = err;
    }

    // "Typed error" — instance check is the load-bearing assertion.
    expect(caught).toBeInstanceOf(SecureDefaultsValidationError);
    if (!(caught instanceof SecureDefaultsValidationError)) return;
    expect(caught.code).toBe("invalid_bind_address");
    // "Actionable message" — the message names the offending value
    // and the allowed Tier-1 set so an operator can act on it
    // without reading source.
    expect(caught.message).toMatch(/0\.0\.0\.0/);
    expect(caught.message).toMatch(/loopback set/);
    // "No partial-start path" — the failed first-time load did NOT
    // leave the singleton in a half-loaded state.
    expect(SecureDefaults.isLoaded()).toBe(false);
    expect(() => SecureDefaults.effectiveSettings()).toThrow();
  });

  it("rejects a non-object config with code='invalid_config' (rules out partial start on top-level bad input)", () => {
    let caught: unknown;
    try {
      // Force a runtime call with a non-object payload through the JS
      // escape hatch. The TypeScript type rules this out at compile
      // time; the runtime guard (source line 247) catches it
      // anyway, which is what we're pinning here.
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
      // Drop `bannerFormat` from the otherwise-valid config. The
      // refuse-unknown-keys check passes (no unknown keys present);
      // the missing-required-key check fires next per source order.
      SecureDefaults.load({
        bindAddress: "127.0.0.1",
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

// ----------------------------------------------------------------------------
// W-007p-1-T3 — I-007-3 effectiveSettings exposes only non-secret typed values
// ----------------------------------------------------------------------------
//
// Per the orchestrator note + advisor confirmation: the assertion
// shape is the EXACT key set of the conservative-config view. Two
// branches are pinned:
//
//   * with-bindPort: `Object.keys(eff).sort()` deep-equals the four
//     allowlisted keys (`bannerFormat`, `bindAddress`, `bindPort`,
//     `localIpcPath`).
//   * without-bindPort: `Object.keys(eff).length === 3` AND
//     `"bindPort" in eff === false`. The `in`-check is the load-
//     bearing assertion: a regression that switched the source to
//     `{ ...x, bindPort: undefined }` would still satisfy
//     `eff.bindPort === undefined` but would NOT satisfy `"bindPort"
//     in eff === false`.
//
// Coupled with the value round-trip assertions (each key carries the
// loaded value verbatim), the exact-key-set assertion catches a
// regression that ADDED a leaking field without changing existing
// behavior.

describe("W-007p-1-T3 (I-007-3: effectiveSettings non-secret typed values)", () => {
  it("returns exactly the four conservative-config keys when bindPort is supplied", () => {
    bootstrap({ ...VALID_BASE_CONFIG, bindPort: 47100 });
    const eff = SecureDefaults.effectiveSettings();

    // The orchestrator-pinned assertion shape: full key-set equality.
    // Sorting both sides removes any insertion-order coupling so a
    // refactor that reorders the validateConfig return literal
    // doesn't break the test.
    const keys = Object.keys(eff).sort();
    expect(keys).toEqual(["bannerFormat", "bindAddress", "bindPort", "localIpcPath"]);
    expect(keys).toHaveLength(4);

    // Value round-trip: each known field carries the loaded value
    // verbatim. A regression that returned a hard-coded constant
    // would still pass the key-set assertion but fail here.
    expect(eff.bindAddress).toBe("127.0.0.1");
    expect(eff.bindPort).toBe(47100);
    expect(eff.localIpcPath).toBe("/tmp/ai-sidekicks-test.sock");
    expect(eff.bannerFormat).toBe("text");

    // The returned view is frozen per source line 203 — assert the
    // freeze invariant so a regression that returned a mutable
    // object is caught here. Mutation attempts on a frozen object
    // throw in strict mode (which all test files run under via
    // Node's ESM `"use strict"` default).
    expect(Object.isFrozen(eff)).toBe(true);
  });

  it("OMITS bindPort from the returned view when input omits it (proves clean-omit branch, not undefined-assignment)", () => {
    // The source has TWO return literals (lines 354-365). The
    // without-bindPort literal omits the key entirely; the with-
    // bindPort literal includes it. This test pins the omit branch
    // — the load-bearing distinction is `"bindPort" in eff === false`,
    // not just `eff.bindPort === undefined`.
    bootstrap(VALID_BASE_CONFIG);
    const eff = SecureDefaults.effectiveSettings();

    expect(Object.keys(eff)).toHaveLength(3);
    expect(Object.keys(eff).sort()).toEqual(["bannerFormat", "bindAddress", "localIpcPath"]);
    // The clean-omit witness — `in`-check, not value-check.
    expect("bindPort" in eff).toBe(false);

    // Other fields still round-trip.
    expect(eff.bindAddress).toBe("127.0.0.1");
    expect(eff.localIpcPath).toBe("/tmp/ai-sidekicks-test.sock");
    expect(eff.bannerFormat).toBe("text");
  });

  it("admits the second loopback set member (`::1`) and the json banner format end-to-end", () => {
    // Belt-and-braces: pin the closed-set branches so a regression
    // that narrowed the loopback set or the banner-format set down
    // to "127.0.0.1" + "text" only would surface here. The four-key
    // set assertion is shared with the earlier with-bindPort case.
    bootstrap({
      bindAddress: "::1",
      bindPort: 47100,
      localIpcPath: "/tmp/ai-sidekicks-test.sock",
      bannerFormat: "json",
    });
    const eff = SecureDefaults.effectiveSettings();
    expect(Object.keys(eff).sort()).toEqual([
      "bannerFormat",
      "bindAddress",
      "bindPort",
      "localIpcPath",
    ]);
    expect(eff.bindAddress).toBe("::1");
    expect(eff.bannerFormat).toBe("json");
  });
});

// ----------------------------------------------------------------------------
// W-007p-1-T4 — I-007-5 Tier-4-scope-key refusal
// ----------------------------------------------------------------------------
//
// The plan names four specific Tier-4-scope keys: `tlsMode`,
// `tlsCertPath`, `nonLoopbackHost`, `firstRunKeysPolicy`. Each must
// be refused with `unknown_setting` AND project to the canonical
// two-layer JSON-RPC envelope per error-contracts.md §JSON-RPC Wire
// Mapping (BL-103 closed 2026-05-01).
//
// Two-layer assertion: the test asserts source-side (typed
// `SecureDefaultsValidationError` with stable `code` string) AND
// wire-side (numeric `-32602 InvalidParams` + `data.type ===
// "unknown_setting"` + `data.fields === { setting, value }`) by
// wrapping the caught error through `mapJsonRpcError`. A regression
// on either the typed-error contract OR the wire-projection seam
// fails the test.
//
// Test shape: `it.each` over the four-key list. Each case feeds an
// otherwise-valid config plus the offending Tier-4 key — the source's
// refuse-unknown-keys walk runs FIRST per validateConfig (lines
// 264-271), so the rest of the config doesn't strictly need to be
// valid for the test to fire, but pinning a valid-otherwise config
// documents intent: "the Tier-4-scope-key refusal is what fires here,
// not some other validation failure".

describe("W-007p-1-T4 (I-007-5: Tier-4-scope-key refusal)", () => {
  // Note: per the orchestrator note + advisor cite, these test
  // objects have to ride a runtime cast through `unknown` because
  // `SecureDefaultsConfig` is a closed structural type that doesn't
  // permit Tier-4 keys at compile time. The runtime walk on
  // `Object.keys` (source line 261-263) is what catches them, which
  // IS the surface we're testing.
  const TIER_4_KEYS: ReadonlyArray<string> = [
    "tlsMode",
    "tlsCertPath",
    "nonLoopbackHost",
    "firstRunKeysPolicy",
  ];

  it.each(TIER_4_KEYS)("refuses key %p with `unknown_setting` envelope", (tier4Key) => {
    const config = {
      ...VALID_BASE_CONFIG,
      [tier4Key]: "any-value",
    } as unknown as SecureDefaultsConfig;

    let caught: unknown;
    try {
      SecureDefaults.load(config);
    } catch (err) {
      caught = err;
    }

    // Source-side: typed error with stable string code. Instance check
    // first so the narrow holds for the field accesses below.
    expect(caught).toBeInstanceOf(SecureDefaultsValidationError);
    if (!(caught instanceof SecureDefaultsValidationError)) return;
    expect(caught.code).toBe("unknown_setting");
    // The message names the offending key so an operator gets an
    // actionable diagnostic at the validation site (vs a generic
    // "config bad" string).
    expect(caught.message).toMatch(new RegExp(tier4Key));

    // Wire-side: `mapJsonRpcError` projects the typed error into the
    // canonical two-layer envelope per error-contracts.md §JSON-RPC
    // Wire Mapping. Numeric -32602 InvalidParams (boot-time config IS
    // request params from the operator's perspective); `data.type` is
    // the stable code string; `data.fields` carries the structured
    // detail captured at the throw site.
    const envelope = mapJsonRpcError(caught, 1);
    expect(envelope.error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.error.data).toEqual({
      type: "unknown_setting",
      fields: { setting: tier4Key, value: "any-value" },
    });

    // Fail-closed side-effect: the singleton stayed unloaded.
    expect(SecureDefaults.isLoaded()).toBe(false);
  });

  it("refuses a config carrying multiple Tier-4 keys at once (refuse-unknown-keys catches the first encountered)", () => {
    // Belt-and-braces: pin that a config with several Tier-4 keys
    // surfaces ONE `unknown_setting` failure (the source loops over
    // input keys and throws on the first violation per source line
    // 264-271). The exact key named in the message depends on JS
    // object-iteration order, so we don't assert which key is
    // surfaced — only that the code is `unknown_setting`.
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

    // Wire envelope is the canonical two-layer shape. The exact
    // surfaced key depends on JS object-iteration order (insertion
    // order for own string keys per ES2015), so we assert the
    // discriminating shape — `type` + `fields.setting` membership in
    // the input set — rather than pinning a specific key.
    const envelope = mapJsonRpcError(caught, 1);
    expect(envelope.error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.error.data?.type).toBe("unknown_setting");
    const fields = envelope.error.data?.fields as Record<string, unknown> | undefined;
    expect(fields?.["setting"]).toMatch(/^(tlsMode|nonLoopbackHost|firstRunKeysPolicy)$/);
  });
});

// ----------------------------------------------------------------------------
// W-007p-1-T5 — I-007-4 single-emit-per-startup
// ----------------------------------------------------------------------------
//
// Three sibling `it()`s, each pinning a distinct facet of I-007-4:
//
//   * "exactly once for a single behavior": basic dedupe — emit the
//     same `behavior` integer twice; sink is invoked once.
//   * "two distinct behaviors emit independently": each behavior has
//     its own dedupe slot; two integers fire two events; a third
//     repeat of either is suppressed.
//   * "mark-before-fire survives a throwing sink": the load-bearing
//     sharpening of I-007-4 — a sink that throws on emit MUST NOT
//     allow a retry to produce a duplicate. Sequence:
//       1. install throwing sink
//       2. emit({behavior:1, ...}) — catches the throw
//       3. assert hasEmitted(1) === true (witness mark-before-fire)
//       4. swap to a counting sink
//       5. emit({behavior:1, ...}) again
//       6. counting sink stayed at 0 invocations
//
// Decision presentation:
//   * Recommendation: three sibling `it()`s under one `describe`.
//   * Alternative: one combined `it()` with all three asserts in
//     sequence.
//   * Why three wins: the failure mode for each facet is distinct.
//     A "dedupe Set never adds" regression breaks facet 1 and 2 but
//     not facet 3. A "mark-after-fire" regression breaks facet 3
//     only. Three sibling cases preserve diagnostic precision: vitest
//     reports the failed facet name directly. The combined-it()
//     alternative would report a generic "I-007-4 broke" and force
//     the reader to bisect the assertions.
//   * Trade-off accepted: three sibling cases each pay the
//     `beforeEach` reset cost (a `Set.clear()` + null-assignment, so
//     the cost is sub-microsecond). Worth it for diagnostic clarity.

describe("W-007p-1-T5 (I-007-4: single-emit-per-startup)", () => {
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
    // Repeats of each behavior must be suppressed.
    SecureDefaultOverrideEmitter.emit(makeOverrideEvent(1));
    SecureDefaultOverrideEmitter.emit(makeOverrideEvent(2));

    expect(sink).toHaveBeenCalledTimes(2);
    // Each behavior fired its own event; the call payloads carry the
    // distinct behavior integers.
    const behaviorsCalled = sink.mock.calls.map((call) => call[0].behavior).sort();
    expect(behaviorsCalled).toEqual([1, 2]);
    expect(SecureDefaultOverrideEmitter.hasEmitted(1)).toBe(true);
    expect(SecureDefaultOverrideEmitter.hasEmitted(2)).toBe(true);
  });

  it("mark-before-fire: a sink that throws still marks the behavior; a retry with a counting sink does NOT produce a duplicate", () => {
    // Step 1: install a throwing sink.
    const throwingSink: SecurityDefaultOverrideSink = () => {
      throw new Error("simulated sink failure");
    };
    SecureDefaultOverrideEmitter.setSink(throwingSink);

    // Step 2: emit. The throw propagates per source line 215; we
    // catch it explicitly so the test can continue past the throw
    // and verify the dedupe-state assertions below.
    expect(() => SecureDefaultOverrideEmitter.emit(makeOverrideEvent(1))).toThrow(
      /simulated sink failure/,
    );

    // Step 3: explicit witness — the dedupe set advanced BEFORE
    // the sink was invoked (mark-before-fire). A regression that
    // marked AFTER the sink call would leave hasEmitted(1) === false
    // here, breaking I-007-4's "unconditional on sink success"
    // guarantee.
    expect(SecureDefaultOverrideEmitter.hasEmitted(1)).toBe(true);

    // Step 4: swap to a counting sink. The sink-replacement contract
    // (source lines 165-172) explicitly preserves the dedupe state
    // across `setSink` calls.
    const countingSink = vi.fn<SecurityDefaultOverrideSink>();
    SecureDefaultOverrideEmitter.setSink(countingSink);

    // Step 5: retry the same behavior. The dedupe set already has
    // `1` marked, so this MUST be a no-op.
    SecureDefaultOverrideEmitter.emit(makeOverrideEvent(1));

    // Step 6: the counting sink stayed at zero invocations — proof
    // that the retry was suppressed by the pre-marked dedupe set,
    // even though the original sink failure was never delivered to
    // the audit log. This is the "exactly one … per startup" wording
    // of I-007-4 in its strictest form.
    expect(countingSink).toHaveBeenCalledTimes(0);
  });

  it("emit() throws when no sink is installed (symmetric pre-condition guard)", () => {
    // This pins the source's setSink-before-emit guard (lines
    // 200-205). Distinct enforcement surface from the dedupe path,
    // but it shares the same I-007-4 invariant — a misconfigured
    // bootstrap that fired an override before wiring the sink would
    // be a programmer error and MUST throw, not silently swallow.
    expect(SecureDefaultOverrideEmitter.hasSink()).toBe(false);
    expect(() => SecureDefaultOverrideEmitter.emit(makeOverrideEvent(1))).toThrow(
      /SecureDefaultOverrideEmitter\.setSink\(sink\) must be called before emit\(\)/,
    );
    // The dedupe set must NOT advance when the no-sink guard fires
    // — otherwise a misconfigured early-emit would silently poison
    // the dedupe slot for the rest of the process. This pins the
    // source's guard-before-mark ordering (line 201 returns/throws
    // before line 214 advances the Set).
    expect(SecureDefaultOverrideEmitter.hasEmitted(1)).toBe(false);
  });
});
