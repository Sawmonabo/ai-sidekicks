// Tests for the `AIS_PTY_BACKEND` grammar of `selectPtyHost`. The env reader, warn sink and both
// factories are injected, so no real env, console, `node-pty` or sidecar binary is touched and
// the suite runs on every platform.

import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { selectPtyHost } from "../pty-host-selector.js";
import type { PtyHostSelectorDeps } from "../pty-host-selector.js";
import { PtyBackendUnavailableError } from "../sidecar-binary-path.js";

import { PTY_BACKEND_UNAVAILABLE_CODE } from "@ai-sidekicks/contracts";
import type { PtyHost } from "../pty-host.js";

/** Stands in for a `NodePtyHost`; the tests assert identity, so the right factory was called. */
const NODE_PTY_SENTINEL: PtyHost = { kind: "NodePtyHost-mock" } as unknown as PtyHost;

/** Stands in for a `RustSidecarPtyHost`; the sidecar supervisor has its own suite. */
const RUST_SIDECAR_SENTINEL: PtyHost = {
  kind: "RustSidecarPtyHost-mock",
} as unknown as PtyHost;

interface SelectorTestCtx {
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

describe("selectPtyHost — AIS_PTY_BACKEND unset", () => {
  it("returns NodePtyHost on every platform without warning", () => {
    // Windows gets no platform-specific default either.
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const { ctx, deps } = buildDeps({ platform, envValue: undefined });

      const host = selectPtyHost(deps);

      expect(host).toBe(NODE_PTY_SENTINEL);
      expect(ctx.createNodePtyHost).toHaveBeenCalledTimes(1);
      // Unset is the silent path: no warning.
      expect(ctx.warn).not.toHaveBeenCalled();
    }
  });
});

describe("selectPtyHost — AIS_PTY_BACKEND=node-pty", () => {
  it("selects NodePtyHost on every platform without warning", () => {
    for (const platform of ["linux", "win32"] as const) {
      const { ctx, deps } = buildDeps({ platform, envValue: "node-pty" });

      const host = selectPtyHost(deps);

      expect(host).toBe(NODE_PTY_SENTINEL);
      expect(ctx.createNodePtyHost).toHaveBeenCalledTimes(1);
      expect(ctx.warn).not.toHaveBeenCalled();
    }
  });
});

describe("selectPtyHost — AIS_PTY_BACKEND=rust-sidecar", () => {
  it("returns the RustSidecarPtyHost on every platform without warning", () => {
    // The platform governs only the default, so a platform gate on this arm would fail here.
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const { ctx, deps } = buildDeps({ platform, envValue: "rust-sidecar" });

      const host = selectPtyHost(deps);

      expect(host).toBe(RUST_SIDECAR_SENTINEL);
      expect(ctx.createRustSidecarPtyHost).toHaveBeenCalledTimes(1);
      expect(ctx.warn).not.toHaveBeenCalled();
      // An explicit selection never falls through to the other backend.
      expect(ctx.createNodePtyHost).not.toHaveBeenCalled();
    }
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
});

describe("selectPtyHost — unrecognized AIS_PTY_BACKEND values fall back with warn", () => {
  const UNRECOGNIZED_CASES: ReadonlyArray<{ value: string; reason: string }> = [
    { value: "Rust-Sidecar", reason: "mixed case — is case-sensitive lowercase" },
    { value: "", reason: "empty string is unrecognized" },
  ];

  for (const { value, reason } of UNRECOGNIZED_CASES) {
    it(`falls back to platform default for value="${value}" (${reason})`, () => {
      const { ctx, deps } = buildDeps({ envValue: value });

      const host = selectPtyHost(deps);

      expect(host).toBe(NODE_PTY_SENTINEL);
      expect(ctx.createNodePtyHost).toHaveBeenCalledTimes(1);

      // The warning text is for the person and must stay exactly this format.
      expect(ctx.warn).toHaveBeenCalledTimes(1);
      expect(ctx.warn).toHaveBeenCalledWith(
        `AIS_PTY_BACKEND='${value}' unrecognized; falling back to platform default`,
      );
    });
  }
});
