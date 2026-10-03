// Tests for `tools/run-node-tests.mjs`. Each case spawns the real script, because the property that
// matters (a zero-matching pattern exits non-zero) exists only at the process boundary.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "..", "run-node-tests.mjs");

const PASSING_TEST_SOURCE = 'import test from "node:test";\ntest("fixture passes", () => {});\n';

/** Build a throwaway tree with `count` passing test files, one nested. */
function makeFixtureTree(count) {
  const root = mkdtempSync(join(tmpdir(), "run-node-tests-"));
  for (let index = 0; index < count; index += 1) {
    // Nest the last file so `**` is exercised, not just a flat `*`.
    const isNested = index === count - 1 && count > 1;
    const directory = isNested ? join(root, "nested") : root;
    if (isNested) mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `fixture-${index}.test.mjs`), PASSING_TEST_SOURCE);
  }
  return root;
}

function runRunner(args) {
  return spawnSync("node", [RUNNER, ...args], { encoding: "utf8" });
}

test("a glob matching nothing exits non-zero and names the pattern", () => {
  const result = runRunner(["no/such/directory/**/*.test.mjs"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no match: no\/such\/directory\/\*\*\/\*\.test\.mjs/);
  // The failure must say why an empty match is fatal.
  assert.match(result.stderr, /exit 0 having run no tests/);
});

test("a real glob alongside a typo'd path still fails, naming the typo'd path", () => {
  const root = makeFixtureTree(2);
  try {
    const result = runRunner([join(root, "**/*.test.mjs"), join(root, "typo-not-here.test.mjs")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no match: .*typo-not-here\.test\.mjs/);
    // A total-only check would have passed on the working glob.
    assert.doesNotMatch(result.stderr, /no match: .*\*\*/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a real glob alone exits 0 and prints the resolved count", () => {
  const root = makeFixtureTree(3);
  try {
    const result = runRunner([join(root, "**/*.test.mjs")]);
    assert.equal(result.status, 0, `expected success, stderr: ${result.stderr}`);
    assert.match(result.stdout, /resolved 3 test file\(s\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--min-files fails closed when the suite shrinks below the floor", () => {
  const root = makeFixtureTree(2);
  try {
    const result = runRunner(["--min-files=3", join(root, "**/*.test.mjs")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /resolved 2 test file\(s\) but --min-files=3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed --min-files is a usage error, not a silently-ignored flag", () => {
  // In the space form the bare flag would parse as a node option and `3` as a pattern, leaving a
  // floor the caller thinks is armed.
  const result = runRunner(["--min-files", "whatever/**/*.test.mjs"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--min-files requires a non-negative integer/);
});

test("no pattern at all is a usage error", () => {
  const result = runRunner([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no test pattern supplied/);
});

// This suite runs under `node --test`, so the wrapper spawned here is a nested run that would
// inherit NODE_TEST_CONTEXT; the test pins that the marker is stripped and the exit code survives.
test("a failing test propagates a non-zero exit through the wrapper", () => {
  const root = mkdtempSync(join(tmpdir(), "run-node-tests-fail-"));
  try {
    writeFileSync(
      join(root, "failing.test.mjs"),
      'import test from "node:test";\ntest("fails", () => {\n  throw new Error("boom");\n});\n',
    );
    const result = runRunner([join(root, "**/*.test.mjs")]);
    assert.notEqual(result.status, 0, "wrapper must not mask a failing suite");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the suite runs on the interpreter that resolved it, not whatever PATH calls `node`", () => {
  // A `node` shim earlier in PATH must never be reached: the runner spawns `process.execPath`, so
  // the file set and the tests run on one interpreter.
  const root = makeFixtureTree(1);
  const shimDirectory = mkdtempSync(join(tmpdir(), "run-node-tests-shim-"));
  const markerPath = join(shimDirectory, "shim-was-invoked");
  try {
    const shimPath = join(shimDirectory, "node");
    writeFileSync(shimPath, `#!/bin/sh\ntouch "${markerPath}"\nexit 0\n`);
    chmodSync(shimPath, 0o755);

    const result = spawnSync(process.execPath, [RUNNER, join(root, "**/*.test.mjs")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${shimDirectory}:${process.env.PATH}` },
    });

    assert.equal(
      existsSync(markerPath),
      false,
      "PATH's `node` shim was invoked — the runner is not pinning process.execPath",
    );
    assert.equal(result.status, 0, `expected the real suite to run, stderr: ${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shimDirectory, { recursive: true, force: true });
  }
});
