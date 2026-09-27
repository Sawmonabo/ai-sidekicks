// The two ways the mutation shards can lose work without failing: a source file
// that lands in no shard is never mutated, and a merge that drops another
// shard's results makes every later run re-test those mutants from scratch.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), "..", "mutation-shards.mjs");

function mutant(testsCompleted) {
  return {
    id: "1",
    mutatorName: "EqualityOperator",
    status: "Killed",
    testsCompleted,
    coveredBy: ["t"],
  };
}

function fixtureRepository() {
  const root = mkdtempSync(join(tmpdir(), "mutation-shards-"));
  const source = join(root, "packages", "sample", "src");
  mkdirSync(join(source, "__tests__"), { recursive: true });
  for (const name of ["heavy.ts", "medium.ts", "light.ts", "unmeasured.ts"]) {
    writeFileSync(join(source, name), "export const value = 1;\n");
  }
  writeFileSync(join(source, "__tests__", "sample.test.ts"), "");
  mkdirSync(join(root, "packages", "sample", ".stryker"));
  writeFileSync(
    join(root, "packages", "sample", ".stryker", "incremental.json"),
    JSON.stringify({
      files: {
        "src/heavy.ts": { mutants: [mutant(2000)] },
        "src/medium.ts": { mutants: [mutant(500)] },
        "src/light.ts": { mutants: [mutant(400)] },
        "src/deleted.ts": { mutants: [mutant(50)] },
      },
      testFiles: {
        "src/__tests__/sample.test.ts": { tests: [] },
        "src/__tests__/deleted.test.ts": { tests: [] },
      },
    }),
  );
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "packages/sample/src"], { cwd: root });
  return root;
}

test("every source file lands in exactly one shard, and the heaviest file gets a shard to itself", () => {
  const root = fixtureRepository();
  try {
    const output = execFileSync("node", [TOOL, "plan"], {
      cwd: root,
      env: { ...process.env, MUTATION_SHARDS: '{"sample": 2}', BASE_SHA: "" },
    });
    const shards = JSON.parse(output.toString()).include.map((entry) => entry.mutate.split(","));
    assert.deepEqual(shards.flat().sort(), [
      "src/heavy.ts",
      "src/light.ts",
      "src/medium.ts",
      "src/unmeasured.ts",
    ]);
    assert.deepEqual(
      shards.find((files) => files.includes("src/heavy.ts")),
      ["src/heavy.ts"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a merge takes each shard's own files, keeps what no shard re-ran, and drops deleted files", () => {
  const root = fixtureRepository();
  try {
    // Each shard's report also carries a stale copy of the other shard's file.
    const shards = [
      { name: "sample--0", mutated: "src/light.ts", fresh: "src/light.ts", stale: "src/medium.ts" },
      {
        name: "sample--1",
        mutated: "src/medium.ts",
        fresh: "src/medium.ts",
        stale: "src/light.ts",
      },
    ];
    for (const shard of shards) {
      const directory = join(root, "results", shard.name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "mutated-files.txt"), `${shard.mutated}\n`);
      writeFileSync(
        join(directory, "incremental.json"),
        JSON.stringify({
          files: {
            [shard.fresh]: { mutants: [mutant(7)] },
            [shard.stale]: { mutants: [mutant(1)] },
          },
          testFiles: {},
        }),
      );
    }
    execFileSync("node", [TOOL, "merge", join(root, "results")], { cwd: root });
    const merged = JSON.parse(
      readFileSync(join(root, "packages", "sample", ".stryker", "incremental.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(merged.files).sort(), [
      "src/heavy.ts",
      "src/light.ts",
      "src/medium.ts",
    ]);
    assert.equal(merged.files["src/light.ts"].mutants[0].testsCompleted, 7);
    assert.equal(merged.files["src/medium.ts"].mutants[0].testsCompleted, 7);
    assert.equal(merged.files["src/heavy.ts"].mutants[0].testsCompleted, 2000);
    assert.deepEqual(Object.keys(merged.testFiles), ["src/__tests__/sample.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
