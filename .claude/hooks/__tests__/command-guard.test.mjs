// node:test suite for the command-guard.py --occupancy CLI and for
// worktree.sh cmd_remove. Both are driven as subprocesses — the repo has no
// Python test framework, so the hooks are pinned from Node.
// Run via: node --test .claude/hooks/__tests__/command-guard.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";

const hooksDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const guardPath = join(hooksDir, "command-guard.py");
const worktreeShPath = join(hooksDir, "worktree.sh");

// ---------- fixture: throwaway git repo with real worktrees ----------

function makeFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "guard-fixture-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const repo = join(root, "repo");
  mkdirSync(repo);
  // Isolate git from the developer's real config so local settings cannot
  // change how the fixture worktrees are created or removed.
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  writeFileSync(
    env.GIT_CONFIG_GLOBAL,
    "[user]\n\temail = test@test.test\n\tname = Test\n[init]\n\tdefaultBranch = main\n",
  );
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result;
  };
  git(["init", "-q"]);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
  return { root, repo, env, git };
}

const fixture = makeFixtureRepo();
fixture.git(["worktree", "add", ".worktrees/wt-a", "-b", "worktree-wt-a"]);
const wtA = join(fixture.repo, ".worktrees", "wt-a");

const occupants = [];
after(() => {
  for (const child of occupants) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(fixture.root, { recursive: true, force: true });
});

// ---------- helpers ----------

function occupancyLines(target, extraArgs = []) {
  const result = spawnSync("python3", [guardPath, "--occupancy", target, ...extraArgs], {
    env: fixture.env,
    encoding: "utf8",
    // Never spawn with cwd inside a fixture worktree: the probe's own
    // process would become the occupant it is asserting on.
    cwd: fixture.repo,
  });
  return {
    status: result.status,
    stderr: result.stderr,
    lines: result.stdout.trim() ? result.stdout.trim().split("\n") : [],
  };
}

// Spawns a detached sleeper whose cwd is `dir` and polls until the
// occupancy engine actually sees it (spawn is asynchronous — asserting
// immediately would flake).
async function spawnOccupant(dir) {
  const child = spawn("sleep", ["300"], {
    cwd: dir,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  occupants.push(child);
  for (let attempt = 0; attempt < 50; attempt++) {
    const { lines } = occupancyLines(dir);
    if (lines.some((line) => line.startsWith(`${child.pid}\t`))) return child;
    await delay(50);
  }
  assert.fail(`occupant ${child.pid} never became visible in ${dir}`);
  return child;
}

async function killOccupant(child, dir) {
  child.kill("SIGKILL");
  for (let attempt = 0; attempt < 50; attempt++) {
    const { lines } = occupancyLines(dir);
    if (!lines.some((line) => line.startsWith(`${child.pid}\t`))) return;
    await delay(50);
  }
  assert.fail(`occupant ${child.pid} never disappeared from ${dir}`);
}

// ---------- --occupancy CLI + lsof field parser ----------

test("--occupancy reports an unoccupied directory as empty with exit 0", () => {
  const { status, lines } = occupancyLines(wtA);
  assert.equal(status, 0);
  assert.deepEqual(lines, []);
});

test("--occupancy parses canned lsof -Fpcn output with boundary discipline", () => {
  const fixtureFile = join(fixture.root, "lsof-fixture.txt");
  writeFileSync(
    fixtureFile,
    [
      "p99991",
      "cnode",
      `n${wtA}`,
      "p99992",
      "czsh",
      `n${wtA}-sibling`,
      "p99993",
      "cbash",
      `n${join(wtA, "nested", "deep")}`,
      "p99994",
      "csleep",
      "n/somewhere/else",
    ].join("\n"),
  );
  const { status, lines } = occupancyLines(wtA, ["--lsof-output-file", fixtureFile]);
  assert.equal(status, 0);
  assert.deepEqual(lines, [`99991\tnode\t${wtA}`, `99993\tbash\t${join(wtA, "nested", "deep")}`]);
});

test("--occupancy exits 2 when enumeration itself fails", () => {
  const { status, stderr } = occupancyLines(wtA, [
    "--lsof-output-file",
    join(fixture.root, "does-not-exist.txt"),
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /occupancy check failed/);
});

test("--occupancy exits 2 on a path that is not an existing directory", () => {
  const missing = join(fixture.root, "no-such-worktree");
  const result = spawnSync("python3", [guardPath, "--occupancy", missing], {
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not a directory/);
  assert.equal(result.stdout, "");
});

test("command-guard: any other invocation prints usage and exits 2", () => {
  const result = spawnSync("python3", [guardPath, "--deny", "git worktree add /tmp/x"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: command-guard\.py --occupancy/);
});

// ---------- worktree.sh cmd_remove ----------

function runWorktreeRemove(worktreePath, options = {}) {
  return spawnSync("bash", [worktreeShPath, "remove"], {
    cwd: options.cwd ?? fixture.repo,
    env: { ...fixture.env, ...(options.env ?? {}) },
    encoding: "utf8",
    input: JSON.stringify({ worktree_path: worktreePath }),
  });
}

test("worktree.sh removes an unoccupied worktree cleanly", () => {
  fixture.git(["worktree", "add", ".worktrees/wt-sh", "-b", "worktree-wt-sh"]);
  const target = join(fixture.repo, ".worktrees", "wt-sh");
  const result = runWorktreeRemove(target);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(target), false);
});

test("worktree.sh refuses an occupied worktree and the directory survives", async () => {
  fixture.git(["worktree", "add", ".worktrees/wt-sh-occ", "-b", "worktree-wt-sh-occ"]);
  const target = join(fixture.repo, ".worktrees", "wt-sh-occ");
  const child = await spawnOccupant(target);
  const result = runWorktreeRemove(target);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /live occupants/);
  assert.match(result.stderr, new RegExp(`${child.pid}`));
  assert.equal(existsSync(target), true);
  await killOccupant(child, target);
  fixture.git(["worktree", "remove", ".worktrees/wt-sh-occ"]);
});

test("worktree.sh escape hatch removes an occupied worktree on request", async () => {
  fixture.git(["worktree", "add", ".worktrees/wt-sh-forced", "-b", "worktree-wt-sh-forced"]);
  const target = join(fixture.repo, ".worktrees", "wt-sh-forced");
  const child = await spawnOccupant(target);
  const result = runWorktreeRemove(target, {
    env: { WORKTREE_REMOVE_ALLOW_OCCUPIED: "1" },
  });
  child.kill("SIGKILL");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(target), false);
});

test("worktree.sh auto-clean shape: invoking lineage inside the worktree does not deadlock", () => {
  fixture.git(["worktree", "add", ".worktrees/wt-sh-self", "-b", "worktree-wt-sh-self"]);
  const target = join(fixture.repo, ".worktrees", "wt-sh-self");
  const payload = JSON.stringify({ worktree_path: target });
  // The intermediate `bash -c` keeps its cwd inside the worktree while the
  // hook runs — it is an ancestor of the occupancy engine and must be
  // excluded, mirroring a harness auto-clean.
  const result = spawnSync(
    "bash",
    ["-c", `cd "${target}" && printf '%s' '${payload}' | bash "${worktreeShPath}" remove`],
    { env: fixture.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(target), false);
});
