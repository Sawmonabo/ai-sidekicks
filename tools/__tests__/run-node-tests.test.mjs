// Tests for tools/run-node-tests.mjs — the fail-closed `node --test` wrapper.
//
// The guard is exercised through `spawnSync` against the real script rather than
// by importing its internals. A unit test that imported the resolver would prove
// the resolver works while leaving the ACTUAL property unverified: that running
// the script with a zero-matching pattern exits non-zero. That property is the
// entire point, and it only exists at the process boundary.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArguments, resolveTestFiles } from "../run-node-tests.mjs";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "..", "run-node-tests.mjs");

const PASSING_TEST_SOURCE = 'import test from "node:test";\ntest("fixture passes", () => {});\n';

/** Build a throwaway tree with `count` passing test files, one nested. */
function makeFixtureTree(count) {
  const root = mkdtempSync(join(tmpdir(), "run-node-tests-"));
  for (let index = 0; index < count; index += 1) {
    // Nest the last file so the `**` segment is genuinely exercised rather than
    // matching a flat directory that a simple `*` would also have caught.
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
  // The rationale must travel with the failure — a bare non-zero exit leaves the
  // next reader to rediscover why an empty match is fatal.
  assert.match(result.stderr, /exit 0 having run no tests/);
});

test("a real glob alongside a typo'd path still fails, naming the typo'd path", () => {
  const root = makeFixtureTree(2);
  try {
    const result = runRunner([join(root, "**/*.test.mjs"), join(root, "typo-not-here.test.mjs")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no match: .*typo-not-here\.test\.mjs/);
    // Guards the per-pattern check specifically: a total-only check would have
    // passed here on the strength of the working glob.
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

test("--min-files passes when the floor is met", () => {
  const root = makeFixtureTree(2);
  try {
    const result = runRunner(["--min-files=2", join(root, "**/*.test.mjs")]);
    assert.equal(result.status, 0, `expected success, stderr: ${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed --min-files is a usage error, not a silently-ignored flag", () => {
  // `--min-files 3` (space form) would otherwise parse the bare flag as a node
  // option and `3` as a pattern — a floor the caller believes is armed but isn't.
  const result = runRunner(["--min-files", "whatever/**/*.test.mjs"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--min-files requires a non-negative integer/);
});

test("no pattern at all is a usage error", () => {
  const result = runRunner([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no test pattern supplied/);
});

// This suite runs UNDER `node --test`, so the wrapper spawned below is a nested
// test run — the exact shape that inherits NODE_TEST_CONTEXT and stops
// propagating its exit code. The test therefore pins the env-stripping fix as
// much as the pass-through itself; it failed before that fix, returning 0.
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

test("parseArguments splits node options, patterns, and the floor", () => {
  const parsed = parseArguments(["--experimental-strip-types", "--min-files=4", "a/**/*.test.mjs"]);
  assert.deepEqual(parsed.forwardedNodeArguments, ["--experimental-strip-types"]);
  assert.deepEqual(parsed.patterns, ["a/**/*.test.mjs"]);
  assert.equal(parsed.minimumFiles, 4);
});

test("`**` spans zero directories as well as many", () => {
  const root = makeFixtureTree(2);
  try {
    // Fixture tree is one file at the root plus one under `nested/`; a `**` that
    // required at least one intermediate segment would find only the nested one.
    const { files } = resolveTestFiles([join(root, "**/*.test.mjs")]);
    assert.equal(files.length, 2);
    assert.ok(files.some((file) => file.includes("nested")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("overlapping patterns run each file exactly once", () => {
  const root = makeFixtureTree(2);
  try {
    const { files } = resolveTestFiles([join(root, "**/*.test.mjs"), join(root, "**/*.mjs")]);
    assert.equal(new Set(files).size, files.length);
    assert.equal(files.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory argument resolves to the test files beneath it", () => {
  const root = makeFixtureTree(2);
  try {
    const { files } = resolveTestFiles([root]);
    assert.equal(files.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the suite runs on the interpreter that resolved it, not whatever PATH calls `node`", () => {
  // Plants a `node` earlier in PATH that would satisfy a `spawnSync("node", …)`
  // call. Because the runner spawns `process.execPath`, the shim must never be
  // reached — otherwise the file set is resolved by one interpreter and the
  // tests execute on another, which is the "green locally, different Node in
  // CI" class.
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
