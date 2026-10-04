// Tests for `tools/lefthook-worktree-lock.mjs` and `tools/lefthook-rc.sh`, the mutex that stops
// two linked worktrees sharing lefthook's unstaged-changes backup.
//
// The suite spawns the real script, since one lock file shared by several processes exists only at
// a process boundary. The rc file is sourced from a stand-in hook, because its contribution is the
// EXIT trap it installs into that shell.

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

test("a held lock refuses a second acquirer and names the holder", () => {
  const directory = makeTemporaryDirectory();
  try {
    const lockPath = join(directory, "lock");
    assert.equal(acquire(lockPath, process.pid).status, 0);

    const blocked = acquire(lockPath, process.pid, ["--timeout-ms=200", "--poll-ms=10"]);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /timed out waiting/);
    assert.match(blocked.stderr, /\/fixture\/worktree/);
    // The refusal must say what it protects, or a reader deletes the lock.
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

    // A stray release must not free another owner's lock; that would share the backup.
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

    // `--stale-after-ms=1` passes the age test at once, so only liveness protects the holder.
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

    // Started from one shell with `&`; run serially the windows could never overlap.
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
      // An interleaved pair is the overlap the lock prevents.
      assert.equal(leaveLabel, enterLabel);
    }
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
 * Builds a throwaway git repository with both scripts and a stand-in for lefthook's generated
 * hook: the `[ -f <rc> ] && . <rc>` line it emits, then a body standing in for `call_lefthook`.
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
    // A release that rewrote the hook's status would accept a rejected commit. The witness keeps
    // this from passing when no lock was ever taken.
    assert.equal(result.status, 7);
    assert.equal(JSON.parse(readFileSync(witnessPath, "utf8")).hookName, "pre-commit");
    assert.throws(() => readFileSync(lockPath, "utf8"), { code: "ENOENT" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the rc file skips the lock when an ancestor hook already holds it", () => {
  const { root, hookPath } = makeHookFixture(
    "pre-commit",
    'if [ -f "$LOCKPATH" ]; then echo held > "$LOCK_WITNESS_TARGET"; ' +
      'else echo free > "$LOCK_WITNESS_TARGET"; fi',
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
    // A nested commit must not wait on the ancestor it is blocking, or it times out minutes later.
    assert.equal(readFileSync(witnessPath, "utf8").trim(), "free");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
