// Tests for `selectPtyHost` — `AIS_PTY_BACKEND` env-var grammar and
// the Phase 2 platform-default contract.
//
// What we assert (Plan-024 §Implementation Step 9 + F-024-2-07)
// -------------------------------------------------------------
//
//   * Default platform (env unset) → `NodePtyHost` on every platform
//     (win32 / darwin / linux). The Phase 2 contract is "always
//     NodePtyHost regardless of platform" — the platform-branch flip
//     is Phase 5 work.
//   * `AIS_PTY_BACKEND="node-pty"` → `NodePtyHost`, NO warn.
//   * `AIS_PTY_BACKEND="rust-sidecar"` → throws `Error` whose message
//     mentions "not yet wired" + Phase 3. NO warn (this is a hard
//     error, not a fallback).
//   * Unrecognized values (mixed-case `"Rust-Sidecar"`, typo
//     `"sidecar"`, typo `"rust"`, empty string `""`, generic typo
//     `"invalid"`) → fall back to platform default AND warn fires
//     with the canonical message format.
//   * Env unset → warn is NOT called (the normal silent path).
//
// Why this runs on every platform — `selectPtyHost`'s production
// dependencies (the env-var reader, the warn sink, the `NodePtyHost`
// factory) are all reachable through `PtyHostSelectorDeps`. The test
// injects `vi.fn()` doubles and a sentinel value for the
// `createNodePtyHost` factory; no real `process.env` is mutated, no
// real `console.warn` is invoked, and `NodePtyHost`'s lazy `node-pty`
// loader is never reached.
//
// Refs: Plan-024 §Implementation Step 9, §F-024-2-02, §F-024-2-07;
// ADR-019 §Decision item 1.

import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { selectPtyHost } from "../pty-host-selector.js";
import type { PtyHostSelectorDeps } from "../pty-host-selector.js";

import type { PtyHost } from "@ai-sidekicks/contracts";

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

interface SelectorTestCtx {
  readEnv: Mock<() => string | undefined>;
  warn: Mock<(message: string) => void>;
  createNodePtyHost: Mock<() => PtyHost>;
}

/**
 * Build a fresh deps record for a single test invocation. Callers
 * override individual fields by passing a partial. Defaults:
 *   * platform = "linux" (most common dev/CI baseline; per-test
 *     overrides exist for the cross-platform assertions).
 *   * readEnv returns `undefined` (env not set).
 *   * warn is a recorded `vi.fn()`.
 *   * createNodePtyHost returns `NODE_PTY_SENTINEL`.
 */
function buildDeps(
  overrides: {
    readonly platform?: NodeJS.Platform;
    readonly envValue?: string | undefined;
  } = {},
): { ctx: SelectorTestCtx; deps: Partial<PtyHostSelectorDeps> } {
  const readEnv: Mock<() => string | undefined> = vi
    .fn<() => string | undefined>()
    .mockReturnValue(overrides.envValue);
  const warn: Mock<(message: string) => void> = vi.fn();
  const createNodePtyHost: Mock<() => PtyHost> = vi
    .fn<() => PtyHost>()
    .mockReturnValue(NODE_PTY_SENTINEL);

  const ctx: SelectorTestCtx = { readEnv, warn, createNodePtyHost };
  const deps: Partial<PtyHostSelectorDeps> = {
    platform: overrides.platform ?? "linux",
    readEnv,
    warn,
    createNodePtyHost,
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

describe("selectPtyHost — AIS_PTY_BACKEND=rust-sidecar (Phase 2 unimplemented branch)", () => {
  it("throws Error with 'not yet wired' message and does NOT warn", () => {
    const { ctx, deps } = buildDeps({ envValue: "rust-sidecar" });

    expect(() => selectPtyHost(deps)).toThrow(/not yet wired/);

    // The throw is the load-bearing assertion per F-024-2-02 and the
    // T-024-2-3 brief — selecting `rust-sidecar` at Phase 2 must be a
    // hard error, not a silent fallback. The warn sink is reserved for
    // the unrecognized-value fallback path; it MUST NOT fire here.
    expect(ctx.warn).not.toHaveBeenCalled();
    // We also MUST NOT have constructed a NodePtyHost — the throw
    // happens before the factory is consulted.
    expect(ctx.createNodePtyHost).not.toHaveBeenCalled();
  });

  it("error message mentions Phase 3 so consumers know when this becomes available", () => {
    // The throw site has a TODO pointing to T-024-3-2 (Phase 3). The
    // message itself documents the upgrade target so operators staring
    // at the error in a daemon log know what to expect; verify the
    // documented behavior so a future message change is deliberate.
    const { deps } = buildDeps({ envValue: "rust-sidecar" });

    expect(() => selectPtyHost(deps)).toThrow(/Phase 3/);
  });

  it("throws on every platform — the unimplemented-throw is platform-agnostic", () => {
    // Phase 2 brief: "AIS_PTY_BACKEND=rust-sidecar throws 'not yet
    // wired'" — there's no per-platform exception. Cover all three
    // platforms so a future Phase 5 PR that accidentally short-
    // circuits the throw on win32 fails this test.
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const { deps } = buildDeps({ platform, envValue: "rust-sidecar" });
      expect(() => selectPtyHost(deps)).toThrow(/not yet wired/);
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
