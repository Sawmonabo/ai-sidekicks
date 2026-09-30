// Tests for the `AIS_PTY_BACKEND` grammar of `selectPtyHost`. The env reader, warn sink and both
// factories are injected, so no real env, console, `node-pty` or sidecar binary is touched and
// the suite runs on every platform.

import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { selectPtyHost } from "../pty-host-selector.js";
import type { PtyHostSelectorDeps } from "../pty-host-selector.js";
import { PtyBackendUnavailableError } from "../sidecar-binary-path.js";

import type { PtyHost } from "@ai-sidekicks/contracts";
import { PTY_BACKEND_UNAVAILABLE_CODE } from "@ai-sidekicks/contracts";

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

/** Stands in for a `NodePtyHost`; the tests assert identity, so the right factory was called. */
const NODE_PTY_SENTINEL: PtyHost = { kind: "NodePtyHost-mock" } as unknown as PtyHost;

/** Stands in for a `RustSidecarPtyHost`; the sidecar supervisor has its own suite. */
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
 * Builds a fresh deps record per test. Defaults: platform "linux", env unset, recording `warn`,
 * and sentinel-returning factories; `rustSidecarFactory` replaces the rust-sidecar factory,
 * for example to make it throw.
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
// Default platform (env unset): always NodePtyHost.
// ----------------------------------------------------------------------------

describe("selectPtyHost — env unset, Phase 2 default-Node on all platforms", () => {
  it("returns NodePtyHost on platform=linux when env-var is undefined", () => {
    const { ctx, deps } = buildDeps({ platform: "linux", envValue: undefined });

    const host = selectPtyHost(deps);

    expect(host).toBe(NODE_PTY_SENTINEL);
    expect(ctx.createNodePtyHost).toHaveBeenCalledTimes(1);
    // Unset is the silent path: no warning.
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
    // Windows must not get a platform-specific default; this fails if a platform branch is added.
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
    const { ctx, deps } = buildDeps({ envValue: "rust-sidecar" });

    const host = selectPtyHost(deps);

    expect(host).toBe(RUST_SIDECAR_SENTINEL);
    expect(ctx.createRustSidecarPtyHost).toHaveBeenCalledTimes(1);
    expect(ctx.warn).not.toHaveBeenCalled();
    // An explicit selection never falls through to the other backend.
    expect(ctx.createNodePtyHost).not.toHaveBeenCalled();
  });

  it("returns the RustSidecarPtyHost on every platform when env-var is rust-sidecar", () => {
    // The platform governs only the default, so a platform gate on this arm would fail here.
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const { ctx, deps } = buildDeps({ platform, envValue: "rust-sidecar" });
      const host = selectPtyHost(deps);
      expect(host).toBe(RUST_SIDECAR_SENTINEL);
      expect(ctx.createRustSidecarPtyHost).toHaveBeenCalledTimes(1);
      expect(ctx.warn).not.toHaveBeenCalled();
    }
  });

  it("rethrows PtyBackendUnavailableError unchanged when the factory itself throws it", () => {
    // Rethrown unchanged, so the original `details.cause` reaches the consumer.
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
    // A raw error from the factory is wrapped, so consumers always see the structured shape.
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
      // The original error rides along as `details.cause`.
      expect(thrown.details.cause).toBe(rawError);
    }
    expect(ctx.warn).not.toHaveBeenCalled();
    expect(ctx.createNodePtyHost).not.toHaveBeenCalled();
  });

  it("wraps a non-Error thrown value (e.g., a string) as PtyBackendUnavailableError too", () => {
    // JS can throw non-Errors; the wrapper keeps the value as `details.cause`.
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
// Unrecognized env values: fall back and warn.
// ----------------------------------------------------------------------------

describe("selectPtyHost — unrecognized AIS_PTY_BACKEND values fall back with warn", () => {
  const UNRECOGNIZED_CASES: ReadonlyArray<{ value: string; reason: string }> = [
    { value: "Rust-Sidecar", reason: "mixed case — is case-sensitive lowercase" },
    { value: "RUST-SIDECAR", reason: "uppercase — case-sensitive lowercase" },
    { value: "rust", reason: "truncated typo of 'rust-sidecar'" },
    { value: "sidecar", reason: "truncated typo of 'rust-sidecar'" },
    { value: "Node-Pty", reason: "mixed case of 'node-pty' — case-sensitive lowercase" },
    { value: "nodepty", reason: "no-hyphen typo of 'node-pty'" },
    {
      value: " node-pty",
      reason: "leading whitespace — grammar is verbatim, no trimming",
    },
    { value: "invalid", reason: "arbitrary unrecognized value" },
    { value: "", reason: "empty string is unrecognized" },
  ];

  for (const { value, reason } of UNRECOGNIZED_CASES) {
    it(`falls back to platform default for value="${value}" (${reason})`, () => {
      const { ctx, deps } = buildDeps({ envValue: value });

      const host = selectPtyHost(deps);

      expect(host).toBe(NODE_PTY_SENTINEL);
      expect(ctx.createNodePtyHost).toHaveBeenCalledTimes(1);

      // The warning text is operator-facing and must stay exactly this format.
      expect(ctx.warn).toHaveBeenCalledTimes(1);
      expect(ctx.warn).toHaveBeenCalledWith(
        `AIS_PTY_BACKEND='${value}' unrecognized; falling back to platform default`,
      );
    });
  }

  it("unrecognized value on win32 still falls back to NodePtyHost (Phase 2 default-Node holds on Windows)", () => {
    // The fallback target is the platform default, which is NodePtyHost on Windows too.
    const { ctx, deps } = buildDeps({ platform: "win32", envValue: "garbage" });

    const host = selectPtyHost(deps);

    expect(host).toBe(NODE_PTY_SENTINEL);
    expect(ctx.warn).toHaveBeenCalledTimes(1);
  });
});

// ----------------------------------------------------------------------------
// The env is read exactly once per selection.
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
