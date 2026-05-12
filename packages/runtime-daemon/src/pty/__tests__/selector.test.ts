// Tests for `selectPtyHost` — `AIS_PTY_BACKEND` env-var grammar and
// the Phase 3 platform-default contract.
//
// What we assert (Plan-024 §Implementation Step 9 + F-024-2-07)
// -------------------------------------------------------------
//
//   * Default platform (env unset) → `NodePtyHost` on every platform
//     (win32 / darwin / linux). Phase 3 keeps the Phase 2 contract
//     of "always NodePtyHost regardless of platform" — the platform-
//     branch flip is Phase 5 work.
//   * `AIS_PTY_BACKEND="node-pty"` → `NodePtyHost`, NO warn.
//   * `AIS_PTY_BACKEND="rust-sidecar"` (Phase 3 wiring):
//       - returns the `RustSidecarPtyHost` from
//         `createRustSidecarPtyHost` factory when the factory
//         resolves cleanly. NO warn (this is the explicit-opt-in
//         path, not the fallback path).
//       - rethrows `PtyBackendUnavailableError` when the factory
//         throws `PtyBackendUnavailableError` directly (preserves
//         original `details.cause`).
//       - wraps an unknown thrown value as `PtyBackendUnavailableError`
//         so the consumer always observes the structured shape rather
//         than the raw spawn errno.
//   * Unrecognized values (mixed-case `"Rust-Sidecar"`, typo
//     `"sidecar"`, typo `"rust"`, empty string `""`, generic typo
//     `"invalid"`) → fall back to platform default AND warn fires
//     with the canonical message format.
//   * Env unset → warn is NOT called (the normal silent path).
//
// Why this runs on every platform — `selectPtyHost`'s production
// dependencies (the env-var reader, the warn sink, the `NodePtyHost`
// factory, the `RustSidecarPtyHost` factory) are all reachable
// through `PtyHostSelectorDeps`. The test injects `vi.fn()` doubles
// and sentinel values for both factories; no real `process.env` is
// mutated, no real `console.warn` is invoked, neither real backend's
// lazy loaders are reached, and no real sidecar binary is spawned.
//
// Refs: Plan-024 §Implementation Step 9, §F-024-2-02, §F-024-2-07;
// ADR-019 §Decision item 1.

import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { selectPtyHost } from "../pty-host-selector.js";
import type { PtyHostSelectorDeps } from "../pty-host-selector.js";
import { PtyBackendUnavailableError } from "../rust-sidecar-pty-host.js";

import type { PtyHost } from "@ai-sidekicks/contracts";
import { PTY_BACKEND_UNAVAILABLE_CODE } from "@ai-sidekicks/contracts";

// ----------------------------------------------------------------------------
// Test fixtures — sentinel host + deps factory
// ----------------------------------------------------------------------------

/**
 * Sentinel value standing in for a real `NodePtyHost`. Cast to
 * `PtyHost` so the selector's return-type contract is honored without
 * actually constructing a NodePtyHost (which would lazily import
 * `node-pty` on first spawn). The test asserts identity, not behavior:
 * if `selectPtyHost` returns this same object reference, the right
 * factory was called.
 */
const NODE_PTY_SENTINEL: PtyHost = { kind: "NodePtyHost-mock" } as unknown as PtyHost;

/**
 * Sentinel value standing in for a real `RustSidecarPtyHost`. Same
 * shape rationale as `NODE_PTY_SENTINEL` — identity test, no
 * behavior. Avoids spawning a real sidecar binary in the selector
 * tests; the supervisor itself has its own dedicated test suite at
 * `rust-sidecar-pty-host.test.ts`.
 */
const RUST_SIDECAR_SENTINEL: PtyHost = {
  kind: "RustSidecarPtyHost-mock",
} as unknown as PtyHost;

interface SelectorTestCtx {
  readEnv: Mock<() => string | undefined>;
  warn: Mock<(message: string) => void>;
  createNodePtyHost: Mock<() => PtyHost>;
  createRustSidecarPtyHost: Mock<() => PtyHost>;
}

/**
 * Build a fresh deps record for a single test invocation. Callers
 * override individual fields by passing a partial. Defaults:
 *   * platform = "linux" (most common dev/CI baseline; per-test
 *     overrides exist for the cross-platform assertions).
 *   * readEnv returns `undefined` (env not set).
 *   * warn is a recorded `vi.fn()`.
 *   * createNodePtyHost returns `NODE_PTY_SENTINEL`.
 *   * createRustSidecarPtyHost returns `RUST_SIDECAR_SENTINEL`.
 *
 * `rustSidecarFactory` override (Phase 3 addition): tests that need
 * the rust-sidecar factory to throw inject a custom function via
 * this override instead of the default sentinel-returning stub.
 */
function buildDeps(
  overrides: {
    readonly platform?: NodeJS.Platform;
    readonly envValue?: string | undefined;
    readonly rustSidecarFactory?: () => PtyHost;
  } = {},
): { ctx: SelectorTestCtx; deps: Partial<PtyHostSelectorDeps> } {
  const readEnv: Mock<() => string | undefined> = vi
    .fn<() => string | undefined>()
    .mockReturnValue(overrides.envValue);
  const warn: Mock<(message: string) => void> = vi.fn();
  const createNodePtyHost: Mock<() => PtyHost> = vi
    .fn<() => PtyHost>()
    .mockReturnValue(NODE_PTY_SENTINEL);
  const createRustSidecarPtyHost: Mock<() => PtyHost> =
    overrides.rustSidecarFactory !== undefined
      ? vi.fn<() => PtyHost>().mockImplementation(overrides.rustSidecarFactory)
      : vi.fn<() => PtyHost>().mockReturnValue(RUST_SIDECAR_SENTINEL);

  const ctx: SelectorTestCtx = {
    readEnv,
    warn,
    createNodePtyHost,
    createRustSidecarPtyHost,
  };
  const deps: Partial<PtyHostSelectorDeps> = {
    platform: overrides.platform ?? "linux",
    readEnv,
    warn,
    createNodePtyHost,
    createRustSidecarPtyHost,
  };
  return { ctx, deps };
}

// ----------------------------------------------------------------------------
// Default platform (env unset) — Phase 2 contract: always NodePtyHost.
// ----------------------------------------------------------------------------

describe("selectPtyHost — env unset, Phase 2 default-Node on all platforms", () => {
  it("returns NodePtyHost on platform=linux when env-var is undefined", () => {
    const { ctx, deps } = buildDeps({ platform: "linux", envValue: undefined });

    const host = selectPtyHost(deps);

    expect(host).toBe(NODE_PTY_SENTINEL);
    expect(ctx.createNodePtyHost).toHaveBeenCalledTimes(1);
    // Env unset is the SILENT platform-default path — warn MUST NOT fire.
    expect(ctx.warn).not.toHaveBeenCalled();
  });

  it("returns NodePtyHost on platform=darwin when env-var is undefined", () => {
    const { ctx, deps } = buildDeps({ platform: "darwin", envValue: undefined });

    const host = selectPtyHost(deps);

    expect(host).toBe(NODE_PTY_SENTINEL);
    expect(ctx.createNodePtyHost).toHaveBeenCalledTimes(1);
    expect(ctx.warn).not.toHaveBeenCalled();
  });

  it("returns NodePtyHost on platform=win32 when env-var is undefined (Phase 2 default-Node holds on Windows too)", () => {
    // Load-bearing for Plan-024 §Step 9 line 124: at Phase 2 the
    // Windows path MUST still return NodePtyHost. The selector default-
    // flip to `RustSidecarPtyHost` is Phase 5 work; if a future change
    // accidentally adds the platform branch early, this test breaks
    // the build deliberately.
    const { ctx, deps } = buildDeps({ platform: "win32", envValue: undefined });

    const host = selectPtyHost(deps);

    expect(host).toBe(NODE_PTY_SENTINEL);
    expect(ctx.createNodePtyHost).toHaveBeenCalledTimes(1);
    expect(ctx.warn).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// Explicit env-var selection — recognized values.
// ----------------------------------------------------------------------------

describe("selectPtyHost — AIS_PTY_BACKEND=node-pty", () => {
  it("selects NodePtyHost and does not warn", () => {
    const { ctx, deps } = buildDeps({ envValue: "node-pty" });

    const host = selectPtyHost(deps);

    expect(host).toBe(NODE_PTY_SENTINEL);
    expect(ctx.createNodePtyHost).toHaveBeenCalledTimes(1);
    // Explicit recognized value — NO warn (this is the explicit-opt-in
    // path, not the fallback path).
    expect(ctx.warn).not.toHaveBeenCalled();
  });

  it("selects NodePtyHost on win32 too (explicit override is platform-agnostic)", () => {
    const { ctx, deps } = buildDeps({ platform: "win32", envValue: "node-pty" });

    const host = selectPtyHost(deps);

    expect(host).toBe(NODE_PTY_SENTINEL);
    expect(ctx.createNodePtyHost).toHaveBeenCalledTimes(1);
    expect(ctx.warn).not.toHaveBeenCalled();
  });
});

describe("selectPtyHost — AIS_PTY_BACKEND=rust-sidecar (Phase 3 wiring)", () => {
  it("returns the RustSidecarPtyHost from the factory and does NOT warn", () => {
    // Phase 3 wiring (per Plan-024 §Implementation Step 9 lines 123–
    // 126 + F-024-2-02): the env-var IS honored, and the
    // rust-sidecar branch routes through the factory rather than
    // throwing. The previous Phase 2 "not yet wired" assertion is
    // replaced by this round-trip identity check.
    const { ctx, deps } = buildDeps({ envValue: "rust-sidecar" });

    const host = selectPtyHost(deps);

    expect(host).toBe(RUST_SIDECAR_SENTINEL);
    expect(ctx.createRustSidecarPtyHost).toHaveBeenCalledTimes(1);
    // Explicit recognized value — NO warn (this is the explicit-opt-
    // in path, not the fallback path). Mirrors the node-pty arm.
    expect(ctx.warn).not.toHaveBeenCalled();
    // We also MUST NOT have constructed a NodePtyHost — the
    // rust-sidecar branch is a hard explicit selection, not a
    // fall-through.
    expect(ctx.createNodePtyHost).not.toHaveBeenCalled();
  });

  it("returns the RustSidecarPtyHost on every platform when env-var is rust-sidecar", () => {
    // Explicit env-var selection is platform-agnostic — the platform
    // branch governs the DEFAULT, not the explicit override. Cover
    // every platform so a future regression that adds platform
    // gating to the rust-sidecar arm fails this test.
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const { ctx, deps } = buildDeps({ platform, envValue: "rust-sidecar" });
      const host = selectPtyHost(deps);
      expect(host).toBe(RUST_SIDECAR_SENTINEL);
      expect(ctx.createRustSidecarPtyHost).toHaveBeenCalledTimes(1);
      expect(ctx.warn).not.toHaveBeenCalled();
    }
  });

  it("rethrows PtyBackendUnavailableError unchanged when the factory itself throws it", () => {
    // The factory may throw `PtyBackendUnavailableError` directly
    // (e.g., the binary-path resolver detected a missing sidecar
    // binary at construction time). The selector must rethrow
    // unchanged so the original `details.cause` (errno object,
    // missing-path string, etc.) is preserved for the consumer.
    const original = new PtyBackendUnavailableError(
      { attemptedBackend: "rust-sidecar", cause: { errno: -2, code: "ENOENT" } },
      "fake binary not found",
    );
    const { ctx, deps } = buildDeps({
      envValue: "rust-sidecar",
      rustSidecarFactory: () => {
        throw original;
      },
    });

    let thrown: unknown = null;
    try {
      selectPtyHost(deps);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(original);
    expect(thrown).toBeInstanceOf(PtyBackendUnavailableError);
    if (thrown instanceof PtyBackendUnavailableError) {
      expect(thrown.code).toBe(PTY_BACKEND_UNAVAILABLE_CODE);
      expect(thrown.details.attemptedBackend).toBe("rust-sidecar");
      expect(thrown.details.cause).toEqual({ errno: -2, code: "ENOENT" });
    }
    expect(ctx.warn).not.toHaveBeenCalled();
    expect(ctx.createNodePtyHost).not.toHaveBeenCalled();
  });

  it("wraps an unknown thrown value as PtyBackendUnavailableError with attemptedBackend=rust-sidecar", () => {
    // If the factory throws something that ISN'T a
    // `PtyBackendUnavailableError` (e.g., a raw `Error` from the
    // spawn-time crash-respawn path before the supervisor can wrap
    // it, or a non-Error thrown value), the selector wraps it so
    // the consumer always observes the structured shape.
    const rawError = new Error("spawn EACCES");
    const { ctx, deps } = buildDeps({
      envValue: "rust-sidecar",
      rustSidecarFactory: () => {
        throw rawError;
      },
    });

    let thrown: unknown = null;
    try {
      selectPtyHost(deps);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PtyBackendUnavailableError);
    if (thrown instanceof PtyBackendUnavailableError) {
      expect(thrown.code).toBe(PTY_BACKEND_UNAVAILABLE_CODE);
      expect(thrown.details.attemptedBackend).toBe("rust-sidecar");
      // The original error rides through as `details.cause` so the
      // consumer can render it for diagnostics. The wrapper does
      // not branch on cause's internal shape (it's `unknown` per
      // the contracts schema).
      expect(thrown.details.cause).toBe(rawError);
    }
    expect(ctx.warn).not.toHaveBeenCalled();
    expect(ctx.createNodePtyHost).not.toHaveBeenCalled();
  });

  it("wraps a non-Error thrown value (e.g., a string) as PtyBackendUnavailableError too", () => {
    // The contract is "any throw becomes structured" — the wrapper
    // must not assume Error instances. JS allows `throw 42` /
    // `throw "boom"`; a defensive wrapper preserves the value as
    // `details.cause` for the consumer to render opaquely.
    const { deps } = buildDeps({
      envValue: "rust-sidecar",
      rustSidecarFactory: () => {
        throw "boom";
      },
    });

    let thrown: unknown = null;
    try {
      selectPtyHost(deps);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PtyBackendUnavailableError);
    if (thrown instanceof PtyBackendUnavailableError) {
      expect(thrown.details.cause).toBe("boom");
    }
  });
});

// ----------------------------------------------------------------------------
// Unrecognized env values — fall back + warn.
// ----------------------------------------------------------------------------

describe("selectPtyHost — unrecognized AIS_PTY_BACKEND values fall back with warn", () => {
  const UNRECOGNIZED_CASES: ReadonlyArray<{ value: string; reason: string }> = [
    { value: "Rust-Sidecar", reason: "mixed case — F-024-2-07 is case-sensitive lowercase" },
    { value: "RUST-SIDECAR", reason: "uppercase — case-sensitive lowercase" },
    { value: "rust", reason: "truncated typo of 'rust-sidecar'" },
    { value: "sidecar", reason: "truncated typo of 'rust-sidecar'" },
    { value: "Node-Pty", reason: "mixed case of 'node-pty' — case-sensitive lowercase" },
    { value: "nodepty", reason: "no-hyphen typo of 'node-pty'" },
    {
      value: " node-pty",
      reason: "leading whitespace — F-024-2-07 grammar is verbatim, no trimming",
    },
    { value: "invalid", reason: "arbitrary unrecognized value" },
    { value: "", reason: "empty string is unrecognized per Plan-024:126" },
  ];

  for (const { value, reason } of UNRECOGNIZED_CASES) {
    it(`falls back to platform default for value="${value}" (${reason})`, () => {
      const { ctx, deps } = buildDeps({ envValue: value });

      const host = selectPtyHost(deps);

      // Load-bearing: returns the platform default (Phase 2: NodePtyHost).
      expect(host).toBe(NODE_PTY_SENTINEL);
      expect(ctx.createNodePtyHost).toHaveBeenCalledTimes(1);

      // Load-bearing: warn fires with the canonical message format
      // documented in Plan-024:126:
      //   `AIS_PTY_BACKEND='<value>' unrecognized; falling back to platform default`
      expect(ctx.warn).toHaveBeenCalledTimes(1);
      expect(ctx.warn).toHaveBeenCalledWith(
        `AIS_PTY_BACKEND='${value}' unrecognized; falling back to platform default`,
      );
    });
  }

  it("unrecognized value on win32 still falls back to NodePtyHost (Phase 2 default-Node holds on Windows)", () => {
    // Cross-platform sanity: the fallback target is the platform
    // default — at Phase 2 that's NodePtyHost on every platform,
    // including win32. Phase 5 will need to update this test when
    // win32's platform default flips to RustSidecarPtyHost.
    const { ctx, deps } = buildDeps({ platform: "win32", envValue: "garbage" });

    const host = selectPtyHost(deps);

    expect(host).toBe(NODE_PTY_SENTINEL);
    expect(ctx.warn).toHaveBeenCalledTimes(1);
  });
});

// ----------------------------------------------------------------------------
// Defensive — readEnv is called exactly once per selection.
// ----------------------------------------------------------------------------

describe("selectPtyHost — env reader is invoked exactly once per call", () => {
  it("calls readEnv exactly once for the unset path", () => {
    const { ctx, deps } = buildDeps({ envValue: undefined });
    selectPtyHost(deps);
    expect(ctx.readEnv).toHaveBeenCalledTimes(1);
  });

  it("calls readEnv exactly once for the recognized-value path", () => {
    const { ctx, deps } = buildDeps({ envValue: "node-pty" });
    selectPtyHost(deps);
    expect(ctx.readEnv).toHaveBeenCalledTimes(1);
  });

  it("calls readEnv exactly once for the unrecognized-value path", () => {
    const { ctx, deps } = buildDeps({ envValue: "garbage" });
    selectPtyHost(deps);
    expect(ctx.readEnv).toHaveBeenCalledTimes(1);
  });
});
