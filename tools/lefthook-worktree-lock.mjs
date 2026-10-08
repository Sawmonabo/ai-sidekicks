#!/usr/bin/env node
// Repository-wide mutex around lefthook's pre-commit run, so two worktrees never sit
// inside its unstaged-changes backup at once. `tools/lefthook-rc.sh` takes it for `pre-commit`.
//
// lefthook hides the unstaged hunks of partially staged files during `pre-commit` and keeps
// the backup where every linked worktree shares it: `info/lefthook-unstaged.patch` in the common
// git dir (git resolves `info` there, not in the worktree's own dir) and the single `refs/stash`,
// whose cleanup drops every stash entry matching its message. A linked worktree's overlapping run
// writes its per-file and whole-tree patches over the main checkout's mid-commit, so the main
// checkout loses its hunks or applies the other tree's. lefthook has no setting that turns the
// backup off or scopes it per worktree, and its upstream fix (evilmartians/lefthook#1530) is
// unreleased.
//
// The lock is one file in the common git dir, made with link(2) from a fully written temporary
// file, so a reader never sees a half-written owner record. A holder killed with SIGKILL leaves the
// file behind. A waiter breaks it only after proving the owner pid is gone and winning an exclusive
// mkdir(2) break slot, so two waiters never both unlink and the lock cannot be re-taken between the
// check and the unlink. A waiter that reaches its deadline exits non-zero and refuses the commit:
// a rejected commit is recoverable, an overwritten worktree is not.

import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

const LOCK_FILE_NAME = "lefthook-unstaged-backup.lock";
const BREAK_SLOT_SUFFIX = ".break";

/** How long a waiter blocks before refusing the commit. */
const DEFAULT_TIMEOUT_MS = 300_000;
/** Gap between acquisition attempts. */
const DEFAULT_POLL_MS = 100;
/**
 * A lock younger than this is never broken even when its owner looks dead. It covers the gap
 * between an acquirer's link(2) and its shell becoming observable, and bounds a recycled pid.
 */
const DEFAULT_STALE_AFTER_MS = 5_000;

class LockUsageError extends Error {}

/** Blocks the thread without spinning; `Atomics.wait` needs no timer or dependency. */
function sleepSynchronously(durationMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

/** Signal 0 only probes the pid: `EPERM` means another user owns it, only `ESRCH` means gone. */
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
 * Reads the owner record and the identity of its file. A breaker re-checks `inode` and
 * `acquiredAtMs` before unlinking, so a lock released and re-taken in between is left alone.
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
    // An unparseable file is still a lock, held by an unknown owner and breakable only by age.
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
 * Removes a lock whose owner is provably gone. Only the waiter that wins `mkdir` of the break slot
 * may unlink, so nothing can re-create the lock between the re-read below and the unlink.
 */
function breakStaleLock(lockPath, observedHolder, staleAfterMs) {
  const breakSlotPath = `${lockPath}${BREAK_SLOT_SUFFIX}`;
  try {
    mkdirSync(breakSlotPath);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    // Another waiter is mid-break, or crashed holding the slot. A live break lasts microseconds,
    // so a slot older than the stale window is abandoned.
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

/**
 * Takes the lock, polling until `timeoutMs`. Returns `{ acquired, holder }`; `holder` is the
 * blocking record when the deadline passed. `onWaitStart` fires once, on the first wait.
 */
function acquireLock({
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

  // Every path reaches the deadline check and the sleep, so a repeating branch cannot spin.
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
function releaseLock({ lockPath, ownerPid }) {
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

/**
 * Runs `acquire`, `release` or `status` from argv and returns the exit code: 0 done, 1 timed out or
 * held. Throws `LockUsageError` on bad usage; the entry point turns that into exit code 2.
 */
function runCommandLine(argv, { stderr = process.stderr } = {}) {
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
          `lefthook: another worktree is mid-commit — waiting ` +
            `for it to finish (${describeHolder(holder)}).\n`,
        );
      },
    });
    if (result.acquired) return 0;
    stderr.write(
      `lefthook: timed out waiting for ${basename(lockPath)}; held by ` +
        `${describeHolder(result.holder)}.\n` +
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
    const holder = readLockHolder(lockPath);
    process.stdout.write(`${lockPath}: ${describeHolder(holder)}\n`);
    return holder === null ? 0 : 1;
  }

  throw new LockUsageError(
    `unknown command: ${command ?? "(none)"} — expected acquire, release or status`,
  );
}

if (import.meta.main) {
  try {
    process.exitCode = runCommandLine(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`lefthook-worktree-lock: ${error.message}\n`);
    process.exitCode = 2;
  }
}
