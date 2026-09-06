// Tests for tools/lefthook-worktree-lock.mjs and tools/lefthook-rc.sh — the
// repository-wide mutex that stops two linked worktrees from sharing lefthook's
// unstaged-changes backup.
//
// The properties that matter only exist at a process boundary (one lock file,
// several processes), so most of this suite spawns the real script rather than
// importing it. The rc file is exercised by sourcing it from a stand-in for
// lefthook's generated hook, because its whole contribution is the EXIT trap it
// installs into that shell — an import could not observe it.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_SCRIPT = join(TOOLS_DIRECTORY, "lefthook-worktree-lock.mjs");
const RC_SCRIPT = join(TOOLS_DIRECTORY, "lefthook-rc.sh");

function makeTemporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "lefthook-worktree-lock-"));
}

function runLockScript(args, options = {}) {
  return spawnSync("node", [LOCK_SCRIPT, ...args], { encoding: "utf8", ...options });
}

function acquire(lockPath, ownerPid, extraArgs = []) {
  return runLockScript([
    "acquire",
    `--lock-path=${lockPath}`,
    `--owner-pid=${ownerPid}`,
    "--worktree=/fixture/worktree",
    ...extraArgs,
  ]);
}

function release(lockPath, ownerPid) {
  return runLockScript(["release", `--lock-path=${lockPath}`, `--owner-pid=${ownerPid}`]);
}

/** A pid that is certainly gone: spawn something trivial and let it exit. */
function deadProcessId() {
  const finished = spawnSync("node", ["-e", "process.exit(0)"]);
  assert.equal(finished.status, 0);
  return finished.pid;
}

test("acquire writes a complete, parseable owner record", () => {
  const directory = makeTemporaryDirectory();
  try {
    const lockPath = join(directory, "lock");
    assert.equal(acquire(lockPath, process.pid).status, 0);
    const record = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(record.ownerPid, process.pid);
    assert.equal(record.worktree, "/fixture/worktree");
    assert.equal(record.hookName, "pre-commit");
    assert.equal(typeof record.acquiredAtMs, "number");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a held lock refuses a second acquirer and names the holder", () => {
  const directory = makeTemporaryDirectory();
  try {
    const lockPath = join(directory, "lock");
    assert.equal(acquire(lockPath, process.pid).status, 0);

    const blocked = acquire(lockPath, process.pid, ["--timeout-ms=200", "--poll-ms=10"]);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /timed out waiting/);
    assert.match(blocked.stderr, /\/fixture\/worktree/);
    // The refusal must say what it protects, or the next reader deletes the lock.
    assert.match(blocked.stderr, /refusing the commit/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release by the owner frees the lock for the next acquirer", () => {
  const directory = makeTemporaryDirectory();
  try {
    const lockPath = join(directory, "lock");
    assert.equal(acquire(lockPath, process.pid).status, 0);
    assert.equal(release(lockPath, process.pid).status, 0);
    assert.equal(acquire(lockPath, process.pid, ["--timeout-ms=200"]).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release by a non-owner leaves the lock in place", () => {
  const directory = makeTemporaryDirectory();
  try {
    const lockPath = join(directory, "lock");
    assert.equal(acquire(lockPath, process.pid).status, 0);

    // A stray release must never free someone else's window — that would hand two
    // worktrees the backup simultaneously, which is the whole failure being fixed.
    assert.equal(release(lockPath, process.pid + 1).status, 0);
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).ownerPid, process.pid);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a lock whose owner is gone is broken once it is older than the stale window", () => {
  const directory = makeTemporaryDirectory();
  try {
    const lockPath = join(directory, "lock");
    const goneProcessId = deadProcessId();
    assert.equal(acquire(lockPath, goneProcessId).status, 0);

    const result = acquire(lockPath, process.pid, [
      "--timeout-ms=3000",
      "--poll-ms=10",
      "--stale-after-ms=1",
    ]);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).ownerPid, process.pid);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a lock whose owner is alive is never broken, however old it looks", () => {
  const directory = makeTemporaryDirectory();
  try {
    const lockPath = join(directory, "lock");
    assert.equal(acquire(lockPath, process.pid).status, 0);

    // `--stale-after-ms=1` makes the age test pass immediately; only the liveness
    // test stands between this acquirer and a live holder's backup window.
    const blocked = acquire(lockPath, process.pid, [
      "--timeout-ms=300",
      "--poll-ms=10",
      "--stale-after-ms=1",
    ]);
    assert.equal(blocked.status, 1);
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).ownerPid, process.pid);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent acquirers never hold the lock at the same time", () => {
  const directory = makeTemporaryDirectory();
  try {
    const lockPath = join(directory, "lock");
    const journalPath = join(directory, "journal");
    writeFileSync(journalPath, "");
    const workerPath = join(directory, "worker.mjs");
    writeFileSync(
      workerPath,
      [
        'import { appendFileSync } from "node:fs";',
        'import { spawnSync } from "node:child_process";',
        "const [lockScript, lockPath, journalPath, label] = process.argv.slice(2);",
        "const lockArgs = [lockScript, `--lock-path=${lockPath}`, `--owner-pid=${process.pid}`];",
        'const acquired = spawnSync("node", [lockArgs[0], "acquire", ...lockArgs.slice(1),',
        '  "--timeout-ms=20000", "--poll-ms=5"], { encoding: "utf8" });',
        "if (acquired.status !== 0) { process.exit(1); }",
        "appendFileSync(journalPath, `enter ${label}\\n`);",
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);",
        "appendFileSync(journalPath, `leave ${label}\\n`);",
        'spawnSync("node", [lockArgs[0], "release", ...lockArgs.slice(1)]);',
      ].join("\n"),
    );

    // Started through one shell with `&`, because `spawnSync` blocks: run serially
    // the four windows could never overlap and the assertion below would be vacuous.
    const parallel = spawnSync(
      "sh",
      [
        "-c",
        `${["a", "b", "c", "d"]
          .map(
            (label) =>
              `node "${workerPath}" "${LOCK_SCRIPT}" "${lockPath}" "${journalPath}" ${label} &`,
          )
          .join(" ")} wait`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(parallel.status, 0, parallel.stderr);

    const entries = readFileSync(journalPath, "utf8").trim().split("\n");
    assert.equal(entries.length, 8);
    for (let index = 0; index < entries.length; index += 2) {
      const [enterVerb, enterLabel] = entries[index].split(" ");
      const [leaveVerb, leaveLabel] = entries[index + 1].split(" ");
      assert.equal(enterVerb, "enter");
      assert.equal(leaveVerb, "leave");
      // An interleaved pair is exactly the overlap this lock exists to prevent.
      assert.equal(leaveLabel, enterLabel);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("status reports whether the lock is held", () => {
  const directory = makeTemporaryDirectory();
  try {
    const lockPath = join(directory, "lock");
    const free = runLockScript(["status", `--lock-path=${lockPath}`]);
    assert.equal(free.status, 0);
    assert.match(free.stdout, /no holder/);

    assert.equal(acquire(lockPath, process.pid).status, 0);
    const held = runLockScript(["status", `--lock-path=${lockPath}`]);
    assert.equal(held.status, 1);
    assert.match(held.stdout, /\/fixture\/worktree/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a malformed invocation exits 2 rather than proceeding unprotected", () => {
  const directory = makeTemporaryDirectory();
  try {
    const lockPath = join(directory, "lock");
    assert.equal(runLockScript(["dance", `--lock-path=${lockPath}`]).status, 2);
    assert.equal(runLockScript(["acquire", `--lock-path=${lockPath}`]).status, 2);
    assert.equal(
      runLockScript(["acquire", `--lock-path=${lockPath}`, "--owner-pid=not-a-pid"]).status,
      2,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Builds a throwaway git repository holding both scripts plus a stand-in for
 * lefthook's generated hook: the same `[ -f <rc> ] && . <rc>` line the template
 * emits, followed by a body that stands in for `call_lefthook`.
 */
function makeHookFixture(hookName, hookBody) {
  const root = makeTemporaryDirectory();
  spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
  mkdirSync(join(root, "tools"), { recursive: true });
  copyFileSync(LOCK_SCRIPT, join(root, "tools", "lefthook-worktree-lock.mjs"));
  copyFileSync(RC_SCRIPT, join(root, "tools", "lefthook-rc.sh"));
  const hookPath = join(root, hookName);
  writeFileSync(
    hookPath,
    `#!/bin/sh\n[ -f tools/lefthook-rc.sh ] && . tools/lefthook-rc.sh\n${hookBody}\n`,
    {
      mode: 0o755,
    },
  );
  return { root, hookPath };
}

function commonGitDirectoryOf(root) {
  return spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim();
}

test("the rc file is valid POSIX shell", () => {
  const parsed = spawnSync("sh", ["-n", RC_SCRIPT], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
});

test("the rc file takes and releases the lock for pre-commit", () => {
  const { root, hookPath } = makeHookFixture(
    "pre-commit",
    'test -f "$LOCK_WITNESS_TARGET" || cp "$LOCKPATH" "$LOCK_WITNESS_TARGET"',
  );
  try {
    const lockPath = join(commonGitDirectoryOf(root), "lefthook-unstaged-backup.lock");
    const witnessPath = join(root, "witness.json");
    const result = spawnSync("sh", [hookPath], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, LOCKPATH: lockPath, LOCK_WITNESS_TARGET: witnessPath },
    });
    assert.equal(result.status, 0, result.stderr);
    // Held while the hook body ran...
    assert.equal(JSON.parse(readFileSync(witnessPath, "utf8")).hookName, "pre-commit");
    // ...and released by the EXIT trap once it finished.
    assert.throws(() => readFileSync(lockPath, "utf8"), { code: "ENOENT" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the rc file releases the lock and preserves the status when the hook fails", () => {
  const { root, hookPath } = makeHookFixture(
    "pre-commit",
    'cp "$LOCKPATH" "$LOCK_WITNESS_TARGET"\nexit 7',
  );
  try {
    const lockPath = join(commonGitDirectoryOf(root), "lefthook-unstaged-backup.lock");
    const witnessPath = join(root, "witness.json");
    const result = spawnSync("sh", [hookPath], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, LOCKPATH: lockPath, LOCK_WITNESS_TARGET: witnessPath },
    });
    // A release that rewrote the hook's verdict would turn a rejected commit into
    // an accepted one, so the status is as load-bearing as the unlink. The witness
    // keeps this non-vacuous: without it the assertions also hold when no lock was
    // ever taken.
    assert.equal(result.status, 7);
    assert.equal(JSON.parse(readFileSync(witnessPath, "utf8")).hookName, "pre-commit");
    assert.throws(() => readFileSync(lockPath, "utf8"), { code: "ENOENT" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the rc file takes no lock for hooks that never touch the backup", () => {
  const { root, hookPath } = makeHookFixture("commit-msg", "true");
  try {
    const lockPath = join(commonGitDirectoryOf(root), "lefthook-unstaged-backup.lock");
    const result = spawnSync("sh", [hookPath], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    // lefthook only hides unstaged changes for `pre-commit`; serializing the rest
    // would queue every commit behind an unrelated worktree for no benefit.
    assert.throws(() => readFileSync(lockPath, "utf8"), { code: "ENOENT" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the rc file skips the lock when an ancestor hook already holds it", () => {
  const { root, hookPath } = makeHookFixture(
    "pre-commit",
    'if [ -f "$LOCKPATH" ]; then echo held > "$LOCK_WITNESS_TARGET"; else echo free > "$LOCK_WITNESS_TARGET"; fi',
  );
  try {
    const lockPath = join(commonGitDirectoryOf(root), "lefthook-unstaged-backup.lock");
    const witnessPath = join(root, "witness.txt");
    const result = spawnSync("sh", [hookPath], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        LOCKPATH: lockPath,
        LOCK_WITNESS_TARGET: witnessPath,
        LEFTHOOK_WORKTREE_BACKUP_LOCK_HELD: "1",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    // A nested commit must not wait on the ancestor whose completion it is
    // blocking: that deadlock resolves only by timing out minutes later.
    assert.equal(readFileSync(witnessPath, "utf8").trim(), "free");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
