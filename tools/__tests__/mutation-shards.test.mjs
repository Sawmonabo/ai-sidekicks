// The two silent ways the shards lose work: a source file in no shard is never mutated, and a merge
// that drops another shard's results makes later runs re-test those mutants.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = join(TOOLS_DIRECTORY, "mutation-shards.mjs");
const STRYKER_CONFIG = join(TOOLS_DIRECTORY, "..", "stryker.config.json");

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
  // The heaviest file sorts last by name, so only a weight-first deal gives it a shard alone.
  for (const name of ["weighty.ts", "medium.ts", "light.ts", "unmeasured.ts"]) {
    writeFileSync(join(source, name), "export const value = 1;\n");
  }
  writeFileSync(join(source, "__tests__", "sample.test.ts"), "");
  // The repository's own config, so its exclusions are the ones the plan must apply.
  copyFileSync(STRYKER_CONFIG, join(root, "stryker.config.json"));
  mkdirSync(join(source, "session"));
  writeFileSync(join(source, "session", "daemon-schema.ts"), "export const schema = '';\n");
  mkdirSync(join(root, "packages", "sample", ".stryker"));
  writeFileSync(
    join(root, "packages", "sample", ".stryker", "incremental.json"),
    JSON.stringify({
      files: {
        "src/weighty.ts": { mutants: [mutant(2000)] },
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

test("every source file lands in exactly one shard; the heaviest gets a shard to itself", () => {
  const root = fixtureRepository();
  try {
    const output = execFileSync("node", [TOOL, "plan"], {
      cwd: root,
      env: { ...process.env, MUTATION_SHARDS: '{"sample": 2}', BASE_SHA: "" },
    });
    const shards = JSON.parse(output.toString()).include.map((entry) => entry.mutate.split(","));
    assert.deepEqual(shards.flat().sort(), [
      "src/light.ts",
      "src/medium.ts",
      "src/unmeasured.ts",
      "src/weighty.ts",
    ]);
    assert.deepEqual(
      shards.find((files) => files.includes("src/weighty.ts")),
      ["src/weighty.ts"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a merge takes each shard's files, keeps what no shard re-ran, drops deleted files", () => {
  const root = fixtureRepository();
  try {
    // Each shard's report also carries a stale copy of the other shard's file.
    const shards = [
      {
        name: "sample--0",
        mutated: "src/light.ts",
        fresh: "src/light.ts",
        stale: "src/medium.ts",
      },
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
      "src/light.ts",
      "src/medium.ts",
      "src/weighty.ts",
    ]);
    assert.equal(merged.files["src/light.ts"].mutants[0].testsCompleted, 7);
    assert.equal(merged.files["src/medium.ts"].mutants[0].testsCompleted, 7);
    assert.equal(merged.files["src/weighty.ts"].mutants[0].testsCompleted, 2000);
    assert.deepEqual(Object.keys(merged.testFiles), ["src/__tests__/sample.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
