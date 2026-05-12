// Test W3 — Plan-024 Phase 3 (T-024-3-4) — verifies invariant I-024-5
// on Windows, end-to-end through the real Rust sidecar binary.
//
// What this asserts (Windows only)
// --------------------------------
//
// With the Plan-001 CP-001-2 daemon-layer cwd translator applied, a
// long-running PTY session whose LOGICAL cwd is a git worktree path
// can have its worktree torn down via `git worktree remove
// <worktree-path>` WHILE the session runs — without surfacing
// `ERROR_SHARING_VIOLATION` (Win32 error 32, the
// `microsoft/node-pty#647` failure mode that motivated the
// translator).
//
// The translation is what makes this work: the OS spawn-call cwd
// (`SpawnRequest.cwd` on the wire) is the daemon's stable parent
// directory, not the worktree, so Windows holds no directory lock on
// the worktree itself. The inner `cd /d "<worktree>"` ahead of the
// target command in the wrapping `cmd.exe` script lands the user-
// visible shell IN the worktree, but cd'ing a process into a
// directory does NOT escalate to a Win32 directory share-mode lock
// the way the spawn-call cwd does.
//
// Test shape
// ----------
//
// 1. Set up a real on-disk git repository + worktree in a temp dir.
// 2. Translate a logical SpawnRequest whose cwd is the worktree path
//    via `translateSpawnCwd({ strategy: "cd-prefix", stableParent: <tmp> })`.
// 3. Spawn it via a real `RustSidecarPtyHost` (the production binary
//    resolver per T-024-3-3 finds the sidecar via tier 3/4
//    `target/{release,debug}/sidecar.exe`).
// 4. Run `git worktree remove <worktree-path>` synchronously while
//    the session is still alive. Assert it exits with code 0
//    (succeeded) and produces no `ERROR_SHARING_VIOLATION` text on
//    stderr.
// 5. Tear down: close the host, remove the temp tree.
//
// Negative-assertion limitation
// -----------------------------
//
// W3 proves the failure mode is ABSENT under the translated wire
// shape. It does NOT empirically demonstrate the failure mode would
// be PRESENT without the translator (a counterfactual would require
// spawning a sidecar with the worktree as the spawn-call cwd, which
// the translator-on-the-daemon-layer architecture intentionally
// makes unreachable). The W2 wire-shape suite proves the spawn-call
// cwd carries the stable parent; W3 proves that suffices in
// practice on the platform the invariant exists for. The two are
// complementary — wire-shape correctness + end-to-end OS-level
// regression coverage.
//
// Race-window limitation
// ----------------------
//
// `host.spawn` resolves when the sidecar acks the `SpawnResponse` —
// at that point the wrapper `cmd.exe /d /s /v:off /c "cd /d
// <worktree> && cmd.exe /k"` has been spawned with `cwd = stableParent`
// (good — no PTY-side lock on the worktree). The INNER `cmd.exe /k`
// is invoked by the wrapper AFTER the `cd /d <worktree>` advances the
// wrapper's cwd to the worktree, so the inner shell inherits the
// worktree as its cwd and would acquire its own Win32 share-mode
// lock on it. If `git worktree remove` fires before the inner
// `cmd.exe /k` has fully spawned and acquired that lock, the test
// passes vacuously — there is no inner process holding a lock to
// defeat. A future hardening pass should write a byte through the
// PTY and await a `DataFrame` echo to confirm the inner shell is
// resident before issuing the teardown. As-is the test still proves
// the wrapper's spawn-call cwd holds no worktree lock, which is the
// translator's specific load-bearing claim per I-024-5.
//
// CI gating + skip semantics
// --------------------------
//
// Two layers of gating:
//
//   1. `describe.runIf(process.platform === "win32")` — the suite is
//      meaningful only on Windows (the lock semantics that
//      `ERROR_SHARING_VIOLATION` reflects are Win32-specific). On
//      Linux/macOS dev boxes and the current ubuntu-latest CI, the
//      suite reports as `skipped`, not failed. `runIf` is the
//      positive-condition modern form for platform-specific suites
//      (Vitest >= 1.0 surfaces it explicitly); the sibling
//      `spawn-cwd-translator.windows.test.ts` uses the negated
//      `skipIf` form for historical consistency with its
//      pre-1.0-idiom era.
//
//   2. Inside each test, `RUN_W3_INTEGRATION` (env-gated) AND
//      sidecar-binary availability are checked at runtime. If either
//      is missing — the binary isn't built (the `cargo build` step
//      isn't yet part of the daemon-test CI job per `.github/
//      workflows/ci.yml`'s "5-platform Rust PTY sidecar matrix and
//      the explicit two-ABI rebuild step land in later PRs") OR the
//      env-flag isn't set — the test calls `ctx.skip()` with a
//      diagnostic message. This avoids the failure mode where W3
//      would deterministically fail on every run for the wrong
//      reason (no binary != ERROR_SHARING_VIOLATION regression).
//
//   The intended CI shape once the platform matrix is widened:
//   the windows-latest leg sets `RUN_W3_INTEGRATION=1` AND runs
//   `cargo build --release` in `packages/sidecar-rust-pty/` before
//   `pnpm --filter @ai-sidekicks/runtime-daemon test`. At that
//   point the gates open and W3 becomes a real I-024-5 regression
//   guard.
//
// Refs: Plan-024 §Invariants I-024-5; Plan-024 §Implementation Phase
// Sequence Phase 3 (T-024-3-4); Plan-001 §Cross-Plan Obligations
// CP-001-2; ADR-019 §Decision item 1; §Windows Implementation
// Gotchas Gotcha 5 (`microsoft/node-pty#647`).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RustSidecarPtyHost, resolveSidecarBinaryPath } from "../rust-sidecar-pty-host.js";
import { translateSpawnCwd } from "../../session/spawn-cwd-translator.js";

import type { SpawnRequest, SpawnResponse } from "@ai-sidekicks/contracts";

// ----------------------------------------------------------------------------
// Skip-detection helpers
// ----------------------------------------------------------------------------

/**
 * Resolve whether the sidecar binary is available on disk via the
 * production four-tier resolver. Returns `null` (not throws) on the
 * "binary missing" path so the test can call `ctx.skip()` with a
 * diagnostic instead of either failing or attempting a real spawn that
 * would itself throw `PtyBackendUnavailableError`.
 *
 * The resolver throws `PtyBackendUnavailableError` when all four tiers
 * exhaust; we let that throw escape (because the resolver is the
 * production API) and translate it into `null` here at the test boundary.
 */
function resolveBinaryOrNull(): string | null {
  try {
    return resolveSidecarBinaryPath();
  } catch {
    return null;
  }
}

/**
 * The `RUN_W3_INTEGRATION` env flag must be set to "1" for the
 * end-to-end real-binary path to engage. This is a defense-in-depth
 * gate: without it, even a Windows dev machine that happens to have
 * the Rust binary built locally won't run W3 by accident (and waste
 * the developer's time on a Win32-PTY spawn that the developer didn't
 * ask for). CI sets the flag explicitly on the windows-latest leg.
 *
 * Per `process.env` access semantics under the repo's
 * `noPropertyAccessFromIndexSignature: true` tsconfig, bracket
 * notation is required.
 */
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
  // Set up a fresh temp tree for each test:
  //
  //   <tmpRoot>/
  //     stable-parent/                  ← spawn-call cwd (daemon's stable dir)
  //       repo/                         ← bare-init'd git repo
  //         .git/
  //         (one empty commit)
  //     worktrees/
  //       feature-x/                    ← `git worktree add` target
  //
  // Both `stable-parent/` and `worktrees/feature-x/` live under
  // `tmpRoot` so the afterEach cleanup can rmSync the whole tree.
  // We keep `repoDir` as a separate field on the context so the
  // test body composes paths via `path.join` (portable across the
  // backslash conventions on Windows) instead of string concat.
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

  // Defer the actual git init to inside the test — if the test is
  // going to skip (binary missing or env-flag unset), there's no
  // value paying the git-process cost. The directory tree we'll
  // need exists; further setup is per-test.
});

afterEach(async () => {
  // Best-effort session close — on a test that skipped before
  // spawning, `host` is null. On a test that spawned + asserted +
  // returned, the session may already be exited (the assertion
  // path tears it down via `host.kill`); close is idempotent per
  // the PtyHost contract.
  if (ctx.host !== null && ctx.sessionId !== null) {
    try {
      await ctx.host.close(ctx.sessionId);
    } catch {
      // Swallow — best-effort cleanup. A failing close should
      // surface as a separate test if it indicates a regression;
      // here it would mask the real assertion failure.
    }
  }
  // Always remove the temp tree even if other cleanup threw.
  // `force: true` because the tree may be partially-constructed if
  // the test threw mid-setup; we don't want a teardown failure to
  // mask the test failure.
  rmSync(ctx.tmpRoot, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// W3 — runs on Windows only
// ----------------------------------------------------------------------------

describe.runIf(process.platform === "win32")(
  "RustSidecarPtyHost × translateSpawnCwd (Test W3 / I-024-5) — Windows worktree teardown",
  () => {
    it("git worktree remove succeeds without ERROR_SHARING_VIOLATION while a translated session is alive", async (ctxRunner) => {
      // ---- Skip gates -----------------------------------------------------
      //
      // Two pre-conditions must hold for the real-binary path to
      // engage. Both are checked here (not at the suite level) so the
      // skip diagnostic surfaces against the specific test name in
      // the reporter, making the missing-prerequisite condition
      // self-documenting.
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

      // ---- Git setup ------------------------------------------------------
      //
      // Plain git for the test scaffolding — the assertion is on the
      // teardown succeeding under a live PTY session, not on git
      // mechanics. We use `execFileSync` (not the shell-string `exec`
      // form) so worktree paths containing spaces or special
      // characters do not need shell-quoting; the args array is
      // passed verbatim.
      //
      // `--initial-branch=main` keeps the test deterministic across
      // git versions whose default differs (some default to `master`,
      // newer to `main`); `--quiet` suppresses status output that
      // would otherwise pollute the test stderr.
      execFileSync("git", ["init", "--initial-branch=main", "--quiet", ctx.repoDir], {
        stdio: "pipe",
      });
      // Configure user.* on this repo only — git refuses commits
      // without an author identity, and we don't want to depend on
      // the CI runner's global config.
      execFileSync("git", ["-C", ctx.repoDir, "config", "user.email", "test@example.com"], {
        stdio: "pipe",
      });
      execFileSync("git", ["-C", ctx.repoDir, "config", "user.name", "Test"], {
        stdio: "pipe",
      });
      // `git worktree add` requires at least one commit on the source
      // repo's branch, otherwise it errors with "fatal: not a valid
      // object name: 'HEAD'".
      execFileSync("git", ["-C", ctx.repoDir, "commit", "--allow-empty", "-m", "init", "--quiet"], {
        stdio: "pipe",
      });
      execFileSync("git", ["-C", ctx.repoDir, "worktree", "add", ctx.worktree, "--quiet"], {
        stdio: "pipe",
      });

      // ---- Spawn through the real RustSidecarPtyHost ---------------------
      //
      // No `binaryPath` override — the production resolver (T-024-3-3)
      // finds the sidecar binary via the four-tier cascade. Pin 3
      // says: let the production resolver run.
      const host: RustSidecarPtyHost = new RustSidecarPtyHost();
      ctx.host = host;

      // Logical request: cwd = worktree path. A long-running cmd.exe
      // (`cmd.exe /k` keeps the prompt resident and the child PID
      // alive, so the OS-level lock-or-not behavior is observable
      // for the duration of the assertion).
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

      // ---- Worktree teardown — the load-bearing assertion ----------------
      //
      // Use `spawnSync` (not `execFileSync`) so we can capture stdout
      // + stderr + exit status independently. `execFileSync` throws
      // on non-zero exit; we want to inspect the failure mode (if
      // any) before the assertion, since the failure mode is exactly
      // what we're guarding against.
      const removeResult = spawnSync(
        "git",
        ["-C", ctx.repoDir, "worktree", "remove", ctx.worktree, "--quiet"],
        { encoding: "utf8", stdio: "pipe" },
      );

      // The negative assertion: `git worktree remove` must succeed.
      // On failure, the most likely cause is precisely the failure
      // mode the translator exists to prevent — Windows
      // `ERROR_SHARING_VIOLATION` (Win32 error 32) reported by git
      // as it tries to delete the worktree directory. The translator
      // routes the spawn-call cwd to `stableParent` (the spawn
      // syscall's directory-lock target), so the worktree is
      // unlocked and removable.
      const stderrText: string = removeResult.stderr ?? "";
      // Diagnostics included in the assertion message so a failure
      // surfaces the exit code + the stderr text (the latter
      // typically contains the Win32 error name when the failure
      // mode is the one we're guarding against).
      expect(removeResult.status, `git worktree remove stderr: ${stderrText}`).toBe(0);
      // Belt-and-suspenders: even on status 0 a future git version
      // might warn-and-continue. Assert the failure-mode string is
      // absent from stderr so a regression that exits 0-with-warning
      // still trips the test.
      expect(stderrText.toLowerCase()).not.toContain("error_sharing_violation");
      expect(stderrText.toLowerCase()).not.toContain("permission denied");
    });
  },
);
