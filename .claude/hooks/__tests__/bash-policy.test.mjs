// node:test suite for bash-policy.py, driven as a subprocess with a hook request on stdin.
// Run via: node --test .claude/hooks/__tests__/bash-policy.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const policyPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bash-policy.py");

// A throwaway checkout holding one of each thing a removal must never reach.
const root = realpathSync(mkdtempSync(join(tmpdir(), "policy-fixture-")));
const home = join(root, "home");
const repo = join(root, "repo");
const outside = join(root, "outside");
const worktree = join(repo, ".worktrees", "wt");
const tempRoot = join(realpathSync("/tmp"), `claude-${process.getuid()}`);
const env = {
  ...process.env,
  HOME: home,
  GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
  GIT_CONFIG_SYSTEM: "/dev/null",
  CLAUDE_PROJECT_DIR: repo,
};

for (const folder of [
  home,
  outside,
  join(repo, "build", "empty"),
  join(repo, "nested", ".git"),
  join(repo, "holder", "inner", ".git"),
  join(repo, "mirror.git"),
  join(repo, "home-inside"),
]) {
  mkdirSync(folder, { recursive: true });
}
writeFileSync(
  env.GIT_CONFIG_GLOBAL,
  "[user]\n\temail = test@test.test\n\tname = Test\n[init]\n\tdefaultBranch = main\n",
);
for (const args of [
  ["init", "-q"],
  ["commit", "-q", "--allow-empty", "-m", "init"],
  ["worktree", "add", "-q", ".worktrees/wt", "-b", "wt"],
]) {
  const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}
for (const file of [
  join(repo, "build", "out.txt"),
  join(repo, ".env"),
  join(repo, "nested", "file.txt"),
  join(repo, "mirror.git", "HEAD"),
  join(repo, "mirror.git", "packed-refs"),
  join(worktree, "file.txt"),
]) {
  writeFileSync(file, "");
}
symlinkSync(outside, join(repo, "link"));

after(() => rmSync(root, { recursive: true, force: true }));

function runPolicy(request, runEnv = env) {
  return spawnSync("python3", ["-I", policyPath], {
    env: runEnv,
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "Bash", ...request }),
  });
}

function refusalOf(command) {
  return runPolicy({
    hook_event_name: "PreToolUse",
    permission_mode: "bypassPermissions",
    cwd: repo,
    tool_input: { command },
  });
}

// Returns "allow", or "ask" when the script printed nothing and so left the prompt to the person.
function answerTo(command, overrides = {}, runEnv = env) {
  const result = runPolicy(
    {
      hook_event_name: "PermissionRequest",
      permission_mode: "bypassPermissions",
      permission_suggestions: [],
      cwd: repo,
      tool_input: { command, description: "a test command" },
      ...overrides,
    },
    runEnv,
  );
  // A crash also prints nothing, so an "ask" counts only from a clean exit.
  assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  if (result.stdout === "") return "ask";
  return JSON.parse(result.stdout).hookSpecificOutput.decision.behavior;
}

test("refuses each banned form before it runs", () => {
  for (const command of [
    "find . -name '*.rs' | xargs rg foo",
    "cd crates && ls",
    "pushd crates",
    "rg -r x foo .",
    "git stash",
    "sh -c 'git stash'",
    "git commit --no-verify -m x",
    "LEFTHOOK=0 git commit -m x",
    "git commit-tree abc",
    "git filter-branch --all",
    "git push --force origin feat/x",
    'git commit -m "a; b" --amend',
  ]) {
    const result = refusalOf(command);
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /^bash-policy: refused, /, command);
  }
  assert.match(
    refusalOf("ls | xargs rg foo").stderr,
    /-exec <program> \{\} \+.*while IFS= read -r/,
  );
});

test("lets through a command that only resembles a banned form", () => {
  for (const command of [
    "rg -n foo .",
    "git commit -m 'tidy the queue'",
    "git push origin feat/x",
    "echo cdrom",
    "rg --files . | sort -r",
    "git commit -F - <<'MESSAGE'\nfix: say why git stash is banned\nMESSAGE",
  ]) {
    const result = refusalOf(command);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  }
});

test("approves a prompted command that holds no rm or rmdir", () => {
  for (const command of [
    `L=${repo}; D=(\${(f)"$(find $L -mindepth 1 -type d | rg -v '/(desktop|pricing)$')"}); rg -n -i '\\bfinal\\b' $D | sed "s|$L/||" | cut -c1-500`,
    "docker run --rm alpine true",
    "./rm-old.sh && rg -n firmware .",
  ]) {
    assert.equal(answerTo(command), "allow", command);
  }
});

test("approves rm and rmdir on spelled-out paths inside the checkout and the temp folder", () => {
  for (const command of [
    "rm -f build/out.txt",
    `rm -rf "${repo}/build" 2>/dev/null; echo done`,
    "rmdir build/empty",
    `rm -rf ${tempRoot}/scratch/run-1`,
    "if [ -f build/out.txt ]; then rm build/out.txt; fi",
    'D=(${(f)"$(ls)"}); rm -f build/out.txt',
    "rm -rf build/*",
    `rm -rf "${repo}/build"/*`,
    `rm -f ${tempRoot}/scratch/*`,
  ]) {
    assert.equal(answerTo(command), "allow", command);
  }
  assert.equal(answerTo("rm -f file.txt", { cwd: worktree }), "allow");
});

test("reads a Monitor's shell command and passes over a Monitor that has none", () => {
  const monitor = { tool_name: "Monitor" };
  assert.equal(answerTo('D=(${(f)"$(ls)"}); echo ${#D}', monitor), "allow");
  assert.equal(answerTo("rm -rf /", monitor), "ask");
  const banned = runPolicy({
    ...monitor,
    hook_event_name: "PreToolUse",
    tool_input: { command: "tail -f run.log | xargs echo" },
  });
  assert.equal(banned.status, 2);
  for (const hook_event_name of ["PreToolUse", "PermissionRequest"]) {
    const result = runPolicy({
      ...monitor,
      hook_event_name,
      permission_mode: "bypassPermissions",
      permission_suggestions: [],
      cwd: repo,
      tool_input: { ws: { url: "wss://events.example.com/stream" }, description: "events" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  }
});

test("leaves the prompt to the person when a removal is not provably inside", () => {
  for (const command of [
    "rm -rf /",
    "RM -rf /",
    "rm -rf ~",
    `rm -rf ${outside}`,
    'rm -rf "$DIR/"',
    "rm -rf $(pwd)",
    "rm -rf *",
    "rm -rf ./*",
    "rm -rf /*",
    `rm -rf ${repo}/*`,
    "rm -rf build/*.txt",
    "rm -rf build*",
    "rm holder/*",
    "rm -rf link/*",
    "rm -rf .",
    "rm",
    "sudo rm -rf build",
    "sh -c 'rm -rf build'",
    "find build -name out.txt -exec rm {} +",
    "git rm build/out.txt",
    "pushd build; rm out.txt",
    "rm build/out.txt -f",
    "rm --no-preserve-root -rf build",
    "rm -rf .git",
    "rm .env",
    "rm -rf .worktrees/wt",
    "rm .worktrees/wt/file.txt",
    "rm nested/file.txt",
    "rm mirror.git/packed-refs",
    "rm -rf holder",
    "rm -rf link/",
  ]) {
    assert.equal(answerTo(command), "ask", command);
  }
  // From build/empty, these name everything in a folder without spelling the folder out.
  for (const command of ["rm -rf ../*", "rm -rf *"]) {
    assert.equal(answerTo(command, { cwd: join(repo, "build", "empty") }), "ask", command);
  }
});

test("a checkout that holds the home folder is no allowed folder", () => {
  const runEnv = { ...env, HOME: join(repo, "home-inside") };
  assert.equal(answerTo("rm -f build/out.txt", {}, runEnv), "ask");
});

test("stays silent outside bypass mode and for a prompt that carries suggestions", () => {
  assert.equal(answerTo("ls", { permission_mode: "default" }), "ask");
  assert.equal(answerTo("ls", { permission_suggestions: [{ type: "addRules" }] }), "ask");
  assert.equal(answerTo("ls", { permission_suggestions: undefined }), "ask");
});
