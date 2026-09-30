// End-to-end check, through the real Rust sidecar binary on Windows, that a git worktree can be
// removed while a PTY session whose logical cwd is that worktree is still running, without
// `ERROR_SHARING_VIOLATION` (Win32 error 32, the `microsoft/node-pty#647` failure).
//
// The daemon's cwd translator makes this work: the spawn-call cwd on the wire is the daemon's
// stable parent directory, so Windows holds no directory lock on the worktree. The inner
// `cd /d "<worktree>"` in the wrapping `cmd.exe` script puts the shell in the worktree, but
// changing directory into it takes no share-mode lock the way a spawn-call cwd does.
//
// Steps: create a real git repo and worktree in a temp dir, translate a worktree-cwd spawn
// request with `translateSpawnCwd({ strategy: "cd-prefix", ... })`, spawn it through a real
// `RustSidecarPtyHost`, run `git worktree remove` while the session is alive, and assert exit
// code 0 with no `ERROR_SHARING_VIOLATION` text on stderr.
//
// Limitations:
//
//   * The test shows the failure is absent under the translated wire shape. It cannot show the
//     failure would occur without the translator, because the translator design makes a
//     worktree spawn-call cwd unreachable. `spawn-cwd-translation.test.ts` covers the wire shape.
//   * `host.spawn` resolves when the sidecar acks the spawn. The wrapper `cmd.exe /d /s /v:off
//     /c "cd /d <worktree> && cmd.exe /k"` then runs with `cwd = stableParent`; the inner
//     `cmd.exe /k` inherits the worktree only after the `cd`. If `git worktree remove` runs
//     before the inner shell has started, the test passes vacuously. It still proves the
//     wrapper's spawn-call cwd holds no lock, which is the translator's claim. Writing a byte
//     through the PTY and awaiting the echo would confirm the inner shell is resident first.
//
// Gating:
//
//   1. `describe.runIf(process.platform === "win32")`: the lock semantics are Win32-specific, so
//      elsewhere the suite reports as skipped.
//   2. Inside the test, `RUN_W3_INTEGRATION=1` and a resolvable sidecar binary are both
//      required, else `ctx.skip()` with a message. Without them the test would fail for the
//      wrong reason (a missing binary is not a lock regression). No CI job sets the flag or
//      builds the sidecar yet; that job would set `RUN_W3_INTEGRATION=1` and run
//      `cargo build --release` in `packages/sidecar-rust-pty/` before the daemon tests.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RustSidecarPtyHost } from "../rust-sidecar-pty-host.js";
import { resolveSidecarBinaryPath } from "../sidecar-binary-path.js";
import { translateSpawnCwd } from "../../session/spawn-cwd-translator.js";

import type { SpawnRequest, SpawnResponse } from "@ai-sidekicks/contracts";

// ----------------------------------------------------------------------------
// Skip-detection helpers
// ----------------------------------------------------------------------------

// Returns `null` when the production resolver finds no binary (it throws
// `PtyBackendUnavailableError`), so the test can skip with a message instead of failing.
function resolveBinaryOrNull(): string | null {
  try {
    return resolveSidecarBinaryPath();
  } catch {
    return null;
  }
}

// Opt-in gate, so a Windows dev machine with the sidecar built locally does not run a real
// Win32 PTY spawn by accident.
function w3Enabled(): boolean {
  return process.env["RUN_W3_INTEGRATION"] === "1";
}

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

interface TestContext {
  readonly tmpRoot: string;
  readonly stableParent: string;
  readonly repoDir: string;
  readonly worktree: string;
  host: RustSidecarPtyHost | null;
  sessionId: string | null;
}

let ctx: TestContext;

beforeEach(() => {
  // Layout under `tmpRoot`, removed whole in afterEach:
  //   stable-parent/         spawn-call cwd (the daemon's stable dir)
  //     repo/                git repo with one empty commit
  //   worktrees/feature-x/   `git worktree add` target
  const tmpRoot: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-w3-"));
  const stableParent: string = join(tmpRoot, "stable-parent");
  const worktreesDir: string = join(tmpRoot, "worktrees");
  const repoDir: string = join(stableParent, "repo");
  const worktreePath: string = join(worktreesDir, "feature-x");

  ctx = {
    tmpRoot,
    stableParent,
    repoDir,
    worktree: worktreePath,
    host: null,
    sessionId: null,
  };

  // Git init happens inside the test, so a skipped test pays no git cost.
});

afterEach(async () => {
  // A skipped test never spawned, so `host` is null; `close` is idempotent for an exited session.
  if (ctx.host !== null && ctx.sessionId !== null) {
    try {
      await ctx.host.close(ctx.sessionId);
    } catch {
      // Best-effort cleanup; a failing close here would mask the real assertion failure.
    }
  }
  // `force` because the tree may be partly built if the test threw mid-setup.
  rmSync(ctx.tmpRoot, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// Windows-only worktree teardown
// ----------------------------------------------------------------------------

describe.runIf(process.platform === "win32")(
  "RustSidecarPtyHost × translateSpawnCwd (Test W3 /) — Windows worktree teardown",
  () => {
    it("git worktree remove succeeds without ERROR_SHARING_VIOLATION while a translated session is alive", async (ctxRunner) => {
      // Checked here, not at suite level, so the skip message names this test in the reporter.
      if (!w3Enabled()) {
        ctxRunner.skip(
          "RUN_W3_INTEGRATION is not set; W3 requires opt-in (CI windows-latest sets it).",
        );
        return;
      }
      const binaryPath: string | null = resolveBinaryOrNull();
      if (binaryPath === null || !existsSync(binaryPath)) {
        ctxRunner.skip(
          "Rust sidecar binary not resolvable (run `cargo build --release` in " +
            "packages/sidecar-rust-pty/ before invoking this test, or set " +
            "AIS_PTY_SIDECAR_BIN=<absolute path>).",
        );
        return;
      }

      // `execFileSync` passes args verbatim, so paths with spaces need no quoting.
      // `--initial-branch=main` avoids git versions whose default differs.
      execFileSync("git", ["init", "--initial-branch=main", "--quiet", ctx.repoDir], {
        stdio: "pipe",
      });
      // Repo-local identity: git refuses commits without one, and the runner's global config
      // cannot be assumed.
      execFileSync("git", ["-C", ctx.repoDir, "config", "user.email", "test@example.com"], {
        stdio: "pipe",
      });
      execFileSync("git", ["-C", ctx.repoDir, "config", "user.name", "Test"], {
        stdio: "pipe",
      });
      // `git worktree add` needs a commit, else it fails with "not a valid object name: 'HEAD'".
      execFileSync("git", ["-C", ctx.repoDir, "commit", "--allow-empty", "-m", "init", "--quiet"], {
        stdio: "pipe",
      });
      execFileSync("git", ["-C", ctx.repoDir, "worktree", "add", ctx.worktree, "--quiet"], {
        stdio: "pipe",
      });

      // No `binaryPath` override: the production resolver finds the sidecar.
      const host: RustSidecarPtyHost = new RustSidecarPtyHost();
      ctx.host = host;

      // `cmd.exe /k` keeps the shell resident, so the lock behavior is observable during the
      // assertion.
      const logical: SpawnRequest = {
        kind: "spawn_request",
        command: "cmd.exe",
        args: ["/k"],
        env: [],
        cwd: ctx.worktree,
        rows: 24,
        cols: 80,
      };

      const translated: SpawnRequest = translateSpawnCwd({
        spec: logical,
        strategy: "cd-prefix",
        stableParent: ctx.stableParent,
        wrappingShell: "windows-cmd",
      });

      const response: SpawnResponse = await host.spawn(translated);
      ctx.sessionId = response.session_id;

      // `spawnSync`, not `execFileSync`, which throws on a non-zero exit before the failure
      // text can be inspected.
      const removeResult = spawnSync(
        "git",
        ["-C", ctx.repoDir, "worktree", "remove", ctx.worktree, "--quiet"],
        { encoding: "utf8", stdio: "pipe" },
      );

      // A failure here most likely means `ERROR_SHARING_VIOLATION`; the stderr text goes in the
      // assertion message.
      const stderrText: string = removeResult.stderr ?? "";
      expect(removeResult.status, `git worktree remove stderr: ${stderrText}`).toBe(0);
      // A git version might warn and still exit 0, so also assert the error text is absent.
      expect(stderrText.toLowerCase()).not.toContain("error_sharing_violation");
      expect(stderrText.toLowerCase()).not.toContain("permission denied");
    });
  },
);
