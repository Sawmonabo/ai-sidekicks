// `resolveSidecarBinaryPath`: four-step resolution (env var, installed package, release build,
// debug build). The first hit wins and later steps are not consulted. When every step misses it
// throws `PtyBackendUnavailableError` listing each step, with the step-2 error as `cause`.

import { sep as pathSep } from "node:path";

import { PTY_BACKEND_UNAVAILABLE_CODE } from "@ai-sidekicks/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  PtyBackendUnavailableError,
  resolveSidecarBinaryPath,
  type ResolveSidecarBinaryPathOptions,
} from "../sidecar-binary-path.js";
import { captureRejection } from "../../workspace/__tests__/workspace.test-support.js";

describe("resolveSidecarBinaryPath — four-step binary resolution", () => {
  // Builds injectable deps whose defaults (empty env, throwing require, false existsSync) make
  // each test opt in to the step it exercises.
  function makeOpts(over?: Partial<ResolveSidecarBinaryPathOptions>): {
    opts: ResolveSidecarBinaryPathOptions;
    requireMock: ReturnType<typeof vi.fn>;
    existsMock: ReturnType<typeof vi.fn>;
  } {
    const requireMock = vi.fn<(id: string) => string>(() => {
      throw new Error("require.resolve: not configured (test default)");
    });
    const existsMock = vi.fn<(p: string) => boolean>(() => false);
    const opts: ResolveSidecarBinaryPathOptions = {
      env: {},
      nodeRequire: { resolve: requireMock },
      existsSync: existsMock,
      releasePath: "/fake/release/sidecar",
      debugPath: "/fake/debug/sidecar",
      platform: "linux",
      ...over,
    };
    return { opts, requireMock, existsMock };
  }

  it("step 1 hits when SIDEKICKS_PTY_SIDECAR_BIN is set to an absolute path that exists (steps 2/3/4 NOT consulted)", () => {
    // The step-1 hit also probes existsSync so a stale env path cannot pass. Steps 2-4 must not
    // be consulted (requireMock is never called).
    const existsMock = vi.fn<(p: string) => boolean>((p) => p === "/abs/path/to/sidecar");
    const { opts, requireMock } = makeOpts({
      env: { SIDEKICKS_PTY_SIDECAR_BIN: "/abs/path/to/sidecar" },
      existsSync: existsMock,
    });

    const result: string = resolveSidecarBinaryPath(opts);

    expect(result).toBe("/abs/path/to/sidecar");
    // One existsSync probe, against the env value; no release or debug probes.
    expect(existsMock).toHaveBeenCalledTimes(1);
    expect(existsMock).toHaveBeenCalledWith("/abs/path/to/sidecar");
    expect(requireMock).not.toHaveBeenCalled();
  });

  it("step 1 rejects an absolute path that does not exist on disk and falls through to step 2", () => {
    // Without the existsSync guard a stale env path would be returned, and every doomed spawn
    // would count against the 5-per-60s crash budget, making the host permanently unavailable
    // after five attempts. The resolver rejects it and falls through to step 2.
    const step2Mock = vi.fn<(id: string) => string>(() => "/installed/pkg/bin/sidecar");
    const existsMock = vi.fn<(p: string) => boolean>(() => false);
    const { opts } = makeOpts({
      env: { SIDEKICKS_PTY_SIDECAR_BIN: "/tmp/path/that/does/not/exist" },
      nodeRequire: { resolve: step2Mock },
      existsSync: existsMock,
    });

    const result: string = resolveSidecarBinaryPath(opts);

    expect(result).toBe("/installed/pkg/bin/sidecar");
    // The env path was probed, returned false, and step 2 took over.
    expect(existsMock).toHaveBeenCalledWith("/tmp/path/that/does/not/exist");
    expect(step2Mock).toHaveBeenCalledTimes(1);
  });

  it("step 1 rejects a relative path (NOT coerced to absolute) and falls through to step 2", () => {
    // A relative path depends on process.cwd(), so the resolver rejects it instead of making it
    // absolute, then consults step 2.
    const step2Mock = vi.fn<(id: string) => string>(() => "/from/step-2/sidecar");
    // The relative path exists, so only the absolute-path check can reject it.
    const existsMock = vi.fn<(p: string) => boolean>((p) => p === "./relative/sidecar");
    const { opts } = makeOpts({
      env: { SIDEKICKS_PTY_SIDECAR_BIN: "./relative/sidecar" },
      nodeRequire: { resolve: step2Mock },
      existsSync: existsMock,
    });

    const result: string = resolveSidecarBinaryPath(opts);

    expect(result).toBe("/from/step-2/sidecar");
    // Step 2 ran, so step 1 did not return the relative path.
    expect(step2Mock).toHaveBeenCalledTimes(1);
  });

  it("step 2 hits when require.resolve returns a path (steps 3/4 NOT consulted)", () => {
    const requireMock = vi.fn<(id: string) => string>(() => "/installed/pkg/bin/sidecar");
    const { opts, existsMock } = makeOpts({
      nodeRequire: { resolve: requireMock },
    });

    const result: string = resolveSidecarBinaryPath(opts);

    expect(result).toBe("/installed/pkg/bin/sidecar");
    // The package id embeds platform and arch.
    expect(requireMock).toHaveBeenCalledTimes(1);
    expect(requireMock).toHaveBeenCalledWith(
      "@ai-sidekicks/pty-sidecar-linux-" + process.arch + "/bin/sidecar",
    );
    // No filesystem probes for steps 3 and 4.
    expect(existsMock).not.toHaveBeenCalled();
  });

  it("step 3 hits when require.resolve throws but the release binary exists on disk (step 4 NOT consulted)", () => {
    const requireMock = vi.fn<(id: string) => string>(() => {
      throw new Error("Cannot find module '@ai-sidekicks/pty-sidecar-linux-x64'");
    });
    // The release probe succeeds; step 4 must not be probed.
    const existsMock = vi.fn<(p: string) => boolean>((p) => p === "/fake/release/sidecar");
    const { opts } = makeOpts({
      nodeRequire: { resolve: requireMock },
      existsSync: existsMock,
    });

    const result: string = resolveSidecarBinaryPath(opts);

    expect(result).toBe("/fake/release/sidecar");
    // Only the release path was probed; step 4 was skipped.
    expect(existsMock).toHaveBeenCalledTimes(1);
    expect(existsMock).toHaveBeenCalledWith("/fake/release/sidecar");
  });

  it("step 4 hits when only the debug binary exists on disk", () => {
    const requireMock = vi.fn<(id: string) => string>(() => {
      throw new Error("Cannot find module");
    });
    const existsMock = vi.fn<(p: string) => boolean>((p) => p === "/fake/debug/sidecar");
    const { opts } = makeOpts({
      nodeRequire: { resolve: requireMock },
      existsSync: existsMock,
    });

    const result: string = resolveSidecarBinaryPath(opts);

    expect(result).toBe("/fake/debug/sidecar");
    // Release was probed first, then debug.
    expect(existsMock).toHaveBeenCalledTimes(2);
    expect(existsMock).toHaveBeenNthCalledWith(1, "/fake/release/sidecar");
    expect(existsMock).toHaveBeenNthCalledWith(2, "/fake/debug/sidecar");
  });

  it("all four steps exhausted → throws PtyBackendUnavailableError enumerating every step failure", async () => {
    // Fresh checkout with no cargo build and no install: the case this error exists for.
    const requireError = new Error("Cannot find module '@ai-sidekicks/pty-sidecar-linux-x64'");
    const requireMock = vi.fn<(id: string) => string>(() => {
      throw requireError;
    });
    const existsMock = vi.fn<(p: string) => boolean>(() => false);
    const { opts } = makeOpts({
      nodeRequire: { resolve: requireMock },
      existsSync: existsMock,
    });

    const thrown = await captureRejection(async () => resolveSidecarBinaryPath(opts));

    expect(thrown).toBeInstanceOf(PtyBackendUnavailableError);
    if (!(thrown instanceof PtyBackendUnavailableError)) {
      return; // Type narrowing for the assertions below.
    }
    expect(thrown.code).toBe(PTY_BACKEND_UNAVAILABLE_CODE);
    expect(thrown.details.attemptedBackend).toBe("rust-sidecar");

    // The message enumerates every step's failure, not just "binary not found".
    expect(thrown.message).toMatch(/step 1 \(env-var SIDEKICKS_PTY_SIDECAR_BIN\): unset/);
    expect(thrown.message).toMatch(/step 2 \(require\.resolve.*\): threw:/);
    expect(thrown.message).toMatch(
      /step 3 \(packages\/sidecar-rust-pty\/target\/release\/sidecar\): not found at \/fake\/release\/sidecar/,
    );
    expect(thrown.message).toMatch(
      /step 4 \(packages\/sidecar-rust-pty\/target\/debug\/sidecar\): not found at \/fake\/debug\/sidecar/,
    );

    // `cause` is the step-2 error: the closest miss on the production path (step 1 is a developer
    // override; steps 3 and 4 are workspace paths).
    expect(thrown.details.cause).toBe(requireError);
  });

  it("on Windows, probes 'sidecar.exe' (not 'sidecar') for step 2 and embeds .exe in step 3/4 diagnostics", async () => {
    // The resolver must add the `.exe` suffix on Windows.
    const requireMock = vi.fn<(id: string) => string>(() => {
      throw new Error("not found");
    });
    const existsMock = vi.fn<(p: string) => boolean>(() => false);
    const { opts } = makeOpts({
      nodeRequire: { resolve: requireMock },
      existsSync: existsMock,
      platform: "win32",
    });

    const thrown = await captureRejection(async () => resolveSidecarBinaryPath(opts));

    expect(requireMock).toHaveBeenCalledWith(
      "@ai-sidekicks/pty-sidecar-win32-" + process.arch + "/bin/sidecar.exe",
    );
    expect(thrown).toBeInstanceOf(PtyBackendUnavailableError);
    if (thrown instanceof PtyBackendUnavailableError) {
      expect(thrown.message).toMatch(
        /step 3 \(packages\/sidecar-rust-pty\/target\/release\/sidecar\.exe\)/,
      );
      expect(thrown.message).toMatch(
        /step 4 \(packages\/sidecar-rust-pty\/target\/debug\/sidecar\.exe\)/,
      );
    }
  });

  it("step 3/4 default paths land inside packages/sidecar-rust-pty/target/{release,debug}/ (pins workspaceTargetPath ascent depth)", async () => {
    // The other resolver tests pass `releasePath` and `debugPath`, which skips the real
    // `workspaceTargetPath` ascent, so a miscounted `../` depth would leave them green. This test
    // omits the overrides and checks the probed paths land in
    // `packages/sidecar-rust-pty/target/{release,debug}/`. It compares `path.sep`-suffixed
    // strings so it holds on POSIX and Windows.
    const requireMock = vi.fn<(id: string) => string>(() => {
      throw new Error("Cannot find module (step-2 forced miss)");
    });
    const existsMock = vi.fn<(p: string) => boolean>(() => false);

    // No path overrides; `platform: "linux"` keeps the binary name free of `.exe`.
    const thrown = await captureRejection(async () =>
      resolveSidecarBinaryPath({
        env: {},
        nodeRequire: { resolve: requireMock },
        existsSync: existsMock,
        platform: "linux",
      }),
    );

    // The two existsSync probes are the release and debug paths.
    expect(existsMock).toHaveBeenCalledTimes(2);
    const releaseProbe: string = existsMock.mock.calls[0]?.[0] ?? "";
    const debugProbe: string = existsMock.mock.calls[1]?.[0] ?? "";
    const releaseSuffix: string =
      pathSep + ["packages", "sidecar-rust-pty", "target", "release", "sidecar"].join(pathSep);
    const debugSuffix: string =
      pathSep + ["packages", "sidecar-rust-pty", "target", "debug", "sidecar"].join(pathSep);
    expect(releaseProbe.endsWith(releaseSuffix)).toBe(true);
    expect(debugProbe.endsWith(debugSuffix)).toBe(true);

    // The rendered diagnostic must embed the same paths that were probed.
    expect(thrown).toBeInstanceOf(PtyBackendUnavailableError);
    if (thrown instanceof PtyBackendUnavailableError) {
      expect(thrown.message).toContain(releaseSuffix);
      expect(thrown.message).toContain(debugSuffix);
    }
  });
});
