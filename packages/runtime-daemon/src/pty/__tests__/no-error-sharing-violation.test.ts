// On Windows, through the real Rust sidecar, `git worktree remove` succeeds while a translated PTY
// session in that worktree runs: the spawn-call cwd is the stable parent, so Windows holds no lock
// (`ERROR_SHARING_VIOLATION`, microsoft/node-pty#647). Opt-in; no CI job runs it yet.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RustSidecarPtyHost } from "../rust-sidecar-pty-host.js";
import { resolveSidecarBinaryPath } from "../sidecar-binary-path.js";
import { translateSpawnCwd } from "../../session/spawn-cwd-translator.js";
import type { SpawnRequest, SpawnResponse } from "../pty-host-protocol.js";

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
function isIntegrationOptedIn(): boolean {
  return process.env["RUN_W3_INTEGRATION"] === "1";
}

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
  const tmpRoot: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-worktree-teardown-"));
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

describe.runIf(process.platform === "win32")(
  "RustSidecarPtyHost × translateSpawnCwd — Windows worktree teardown",
  () => {
    it("git worktree remove succeeds without ERROR_SHARING_VIOLATION while a translated session is alive", async (ctxRunner) => {
      // Checked here, not at suite level, so the skip message names this test in the reporter.
      if (!isIntegrationOptedIn()) {
        ctxRunner.skip("RUN_W3_INTEGRATION is not set; this test runs only on opt-in.");
        return;
      }
      const binaryPath: string | null = resolveBinaryOrNull();
      if (binaryPath === null || !existsSync(binaryPath)) {
        ctxRunner.skip(
          "Rust sidecar binary not resolvable (run `cargo build --release` in " +
            "packages/sidecar-rust-pty/ before invoking this test, or set " +
            "SIDEKICKS_PTY_SIDECAR_BIN=<absolute path>).",
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

      // `spawn` resolves on the sidecar's ack, possibly before the inner shell has run its `cd`;
      // the wrapper's spawn-call cwd, the translator's claim, is what holds or releases the lock.
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
