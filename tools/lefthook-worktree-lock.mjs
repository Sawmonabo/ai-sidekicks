#!/usr/bin/env node
// lefthook-worktree-lock — a repository-wide mutex around lefthook's pre-commit
// run, so two linked worktrees never sit inside its unstaged-changes backup
// window at the same time.
//
// WHY THIS EXISTS
//
// lefthook v2.1.6 hides the unstaged hunks of partially staged files for the
// duration of a `pre-commit` run, and it keeps the backup in two places that
// every linked worktree of a repository shares:
//
//   1. `<common git dir>/info/lefthook-unstaged.patch`. `internal/git/repository.go`
//      builds the path as `filepath.Join(InfoPath, "lefthook-unstaged.patch")`,
//      where `InfoPath` is the `--git-path info` field of
//      `git rev-parse --path-format=absolute --show-toplevel --git-path hooks
//      --git-path info --git-dir`. Git resolves `info` against the COMMON git
//      dir, so a linked worktree gets `<repo>/.git/info`, not its own
//      `<repo>/.git/worktrees/<name>/info`. Every worktree writes one file.
//   2. The `lefthook auto backup` stash. `refs/stash` is a single shared ref,
//      and `DropUnstagedStash` walks the whole `git stash list` dropping EVERY
//      entry whose message matches — not only the one this process stored.
//
// The guard engages for a hook named exactly `pre-commit` whenever at least one
// file is partially staged (`internal/run/controller/controller.go` builds it as
// `!opts.NoStageFixed && config.HookUsesStagedFiles(hook.Name)`, and
// `HookUsesStagedFiles` returns `hook == "pre-commit"`). It is not gated by any
// job's `stage_fixed:`, and lefthook v2.1.6 exposes no configuration key that
// turns it off or moves it per worktree — see `CONTRIBUTING.md` §Pre-Commit Hooks.
//
// Interleaving two runs therefore either applies one worktree's hunks into the
// other's tree or deletes them outright, while both commits report success.
//
// Line references above are v2.1.6, this repo's pin. The generated hook resolves
// `lefthook` from PATH before falling back to `node_modules`, so a developer can
// be running a newer 2.1.x; every one of these points is unchanged through
// v2.1.9, where `repository.go` is split into `internal/git/paths.go` and
// `internal/git/repo.go` without touching the path, the message-keyed drop, or
// the hook-name condition. The upstream fix (evilmartians/lefthook#1530) is open
// and unreleased.
//
// WHAT THIS DOES
//
// `tools/lefthook-rc.sh` — wired in as lefthook's `rc:` file, so it is sourced by
// the generated hook BEFORE lefthook starts and can therefore cover the whole
// backup window — acquires this lock for `pre-commit` and releases it from an
// EXIT trap. The lock is one file in the common git dir, so its scope is exactly
// the set of worktrees that share the backup.
//
// The lock file is created with link(2) from a fully written temporary file, so
// it never exists in a half-written state: a reader either sees no lock or sees a
// complete owner record. A holder that dies without releasing (SIGKILL) leaves
// the file behind; a waiter breaks it only after proving the owning pid is gone
// AND claiming an exclusive break slot with mkdir(2), so two waiters can never
// both unlink — and because only the break-slot winner may unlink, the lock
// cannot be re-acquired between that winner's verification and its unlink.
//
// A waiter that reaches its deadline exits non-zero and refuses the commit rather
// than proceeding unprotected: a rejected commit is recoverable, an overwritten
// worktree is not.

import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOCK_FILE_NAME = "lefthook-unstaged-backup.lock";
const BREAK_SLOT_SUFFIX = ".break";

/** How long a waiter blocks before refusing the commit. */
const DEFAULT_TIMEOUT_MS = 300_000;
/** Gap between acquisition attempts. Short enough to feel instant, long enough not to spin. */
const DEFAULT_POLL_MS = 100;
/**
 * A lock younger than this is never broken even when its owner looks dead. It
 * covers the window between another acquirer's link(2) and the moment its shell
 * is observable, and it bounds the damage of a recycled pid.
 */
const DEFAULT_STALE_AFTER_MS = 5_000;

class LockUsageError extends Error {}

/** Sleep without spinning. `Atomics.wait` blocks the thread with no dependency and no timer. */
function sleepSynchronously(durationMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

/**
 * `process.kill(pid, 0)` sends no signal; it only reports whether the pid can be
 * signalled. `EPERM` means the process exists under another user, which is still
 * alive for our purposes. Only `ESRCH` proves it is gone.
 */
function isProcessAlive(processId) {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function resolveDefaultLockPath(startDirectory) {
  const commonGitDirectory = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: startDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  if (!commonGitDirectory) {
    throw new LockUsageError("git rev-parse --git-common-dir produced no path");
  }
  return join(commonGitDirectory, LOCK_FILE_NAME);
}

/**
 * Reads the owner record plus the identity of the file it came from. `inode` and
 * `acquiredAtMs` together are what a breaker re-verifies before unlinking, so a
 * lock that was released and re-taken in the meantime is left alone.
 */
function readLockHolder(lockPath) {
  let fileStat;
  try {
    fileStat = statSync(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let record = null;
  try {
    record = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    // A lock this process cannot parse was written by an incompatible version or
    // truncated by a crash. It is still a lock: treat it as held by an unknown
    // owner, which makes it breakable only through the age path below.
  }
  return { record, inode: fileStat.ino, ageMs: Date.now() - fileStat.mtimeMs };
}

function tryCreateLockFile(lockPath, record) {
  const temporaryPath = `${lockPath}.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
    linkSync(temporaryPath, lockPath);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

/**
 * Removes a lock whose owner is provably gone.
 *
 * `mkdir` of the break slot is the atomic claim: exactly one waiter holds it, so
 * two waiters cannot both unlink, and since no other actor may remove the lock
 * file, nothing can re-create it between the re-read below and the unlink.
 */
function breakStaleLock(lockPath, observedHolder, staleAfterMs) {
  const breakSlotPath = `${lockPath}${BREAK_SLOT_SUFFIX}`;
  try {
    mkdirSync(breakSlotPath);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    // Another waiter is mid-break, or one crashed while holding the slot. Only
    // the second case needs action, and only once the slot is older than a lock
    // would be — a live break lasts microseconds.
    let breakSlotStat;
    try {
      breakSlotStat = statSync(breakSlotPath);
    } catch (statError) {
      if (statError.code === "ENOENT") return false;
      throw statError;
    }
    if (Date.now() - breakSlotStat.mtimeMs >= staleAfterMs) {
      rmSync(breakSlotPath, { recursive: true, force: true });
    }
    return false;
  }
  try {
    const currentHolder = readLockHolder(lockPath);
    if (currentHolder === null) return false;
    if (currentHolder.inode !== observedHolder.inode) return false;
    if (currentHolder.record?.acquiredAtMs !== observedHolder.record?.acquiredAtMs) return false;
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  } finally {
    rmSync(breakSlotPath, { recursive: true, force: true });
  }
}

function describeHolder(holder) {
  if (holder === null) return "no holder";
  const record = holder.record ?? {};
  const owner = record.ownerPid ?? "unknown pid";
  const worktree = record.worktree ?? "unknown worktree";
  return `pid ${owner} in ${worktree} (held for ${Math.round(holder.ageMs / 1000)}s)`;
}

export function acquireLock({
  lockPath,
  ownerPid,
  worktree,
  hookName,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  onWaitStart = () => {},
}) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const record = {
    ownerPid,
    worktree,
    hookName,
    acquiredAt: new Date().toISOString(),
    acquiredAtMs: Date.now(),
  };
  const deadline = Date.now() + timeoutMs;
  let announcedWait = false;

  // Every path through the body reaches the deadline check and the sleep below.
  // An earlier shape jumped back to the top on the "holder vanished" and
  // "broke a stale lock" branches, which are the two branches that can repeat
  // without progress — a spin with no deadline and no sleep.
  for (;;) {
    if (tryCreateLockFile(lockPath, record)) return { acquired: true, holder: null };

    const holder = readLockHolder(lockPath);
    if (holder !== null) {
      const ownerIsGone = !isProcessAlive(holder.record?.ownerPid);
      if (ownerIsGone && holder.ageMs >= staleAfterMs) {
        breakStaleLock(lockPath, holder, staleAfterMs);
      } else if (!announcedWait) {
        announcedWait = true;
        onWaitStart(holder);
      }
    }
    if (Date.now() >= deadline) return { acquired: false, holder };
    sleepSynchronously(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

/** Releases only a lock this owner holds. Someone else's lock is never touched. */
export function releaseLock({ lockPath, ownerPid }) {
  const holder = readLockHolder(lockPath);
  if (holder === null) return { released: false, reason: "not-held" };
  if (holder.record?.ownerPid !== ownerPid) return { released: false, reason: "owned-by-other" };
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { released: false, reason: "not-held" };
  }
  return { released: true, reason: "released" };
}

export function readLockStatus({ lockPath }) {
  return readLockHolder(lockPath);
}

function parseCommandLine(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (const argument of rest) {
    const match = /^--([a-z][a-z-]*)=(.*)$/.exec(argument);
    if (match === null) throw new LockUsageError(`unrecognized argument: ${argument}`);
    const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = match[2];
  }
  return { command, options };
}

function requireInteger(options, key) {
  const raw = options[key];
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new LockUsageError(
      `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a positive integer`,
    );
  }
  return value;
}

function optionalInteger(options, key, fallback) {
  if (options[key] === undefined) return fallback;
  return requireInteger(options, key);
}

export function runCommandLine(argv, { stderr = process.stderr } = {}) {
  const { command, options } = parseCommandLine(argv);
  const lockPath = options.lockPath ?? resolveDefaultLockPath(options.worktree ?? process.cwd());

  if (command === "acquire") {
    const result = acquireLock({
      lockPath,
      ownerPid: requireInteger(options, "ownerPid"),
      worktree: options.worktree ?? process.cwd(),
      hookName: options.hookName ?? "pre-commit",
      timeoutMs: optionalInteger(options, "timeoutMs", DEFAULT_TIMEOUT_MS),
      pollMs: optionalInteger(options, "pollMs", DEFAULT_POLL_MS),
      staleAfterMs: optionalInteger(options, "staleAfterMs", DEFAULT_STALE_AFTER_MS),
      onWaitStart: (holder) => {
        stderr.write(
          `lefthook: another worktree is mid-commit — waiting for it to finish (${describeHolder(holder)}).\n`,
        );
      },
    });
    if (result.acquired) return 0;
    stderr.write(
      `lefthook: timed out waiting for ${basename(lockPath)}; held by ${describeHolder(result.holder)}.\n` +
        `lefthook: refusing the commit rather than sharing lefthook's unstaged-changes backup.\n` +
        `lefthook: if that process is gone, delete ${lockPath} and retry.\n`,
    );
    return 1;
  }

  if (command === "release") {
    releaseLock({ lockPath, ownerPid: requireInteger(options, "ownerPid") });
    return 0;
  }

  if (command === "status") {
    const holder = readLockStatus({ lockPath });
    process.stdout.write(`${lockPath}: ${describeHolder(holder)}\n`);
    return holder === null ? 0 : 1;
  }

  throw new LockUsageError(
    `unknown command: ${command ?? "(none)"} — expected acquire, release or status`,
  );
}

/**
 * Direct-invocation guard in the repo's canonical form (`tools/run-node-tests.mjs`
 * § isDirectlyInvoked), and NOT the naive
 * ``import.meta.url === `file://${process.argv[1]}` ``: that compares a
 * percent-ENCODED URL against a raw path, so a checkout under a directory
 * containing a space (or `#`, `?`, non-ASCII) makes the two unequal, this CLI
 * exits 0 having taken no lock, and the hook sails on into an unprotected backup
 * window — precisely the failure this file exists to prevent. `realpathSync` on
 * both sides additionally survives a symlinked invocation.
 */
function isDirectlyInvoked() {
  const invokedPath = process.argv[1];
  if (typeof invokedPath !== "string") return false;
  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that will not resolve to a real file was not this module's entry
    // point, so `false` is the correct answer rather than a swallowed failure.
    return false;
  }
}

if (isDirectlyInvoked()) {
  try {
    process.exitCode = runCommandLine(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`lefthook-worktree-lock: ${error.message}\n`);
    process.exitCode = 2;
  }
}
