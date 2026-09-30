#!/usr/bin/env node
// Splits the packages' mutation testing into CI shards and merges the shards' results back into one
// incremental file per package. StrykerJS has no sharding of its own (stryker-js#4806) and one
// package's full run takes hours, so CI runs `stryker run --mutate <files>` per shard.
//
//   plan  - prints the GitHub Actions matrix. A pull request's shards hold only the source files it
//           changed (`BASE_SHA` set); otherwise every source file. Files are dealt heaviest first
//           onto the lightest shard, weighed by the tests each file's mutants ran in the saved
//           results (a static mutant runs the whole suite), or by source length with no result yet.
//   merge - folds each shard's results for the files it mutated over the package's saved ones, so
//           the next run of any shard layout reuses every result.
//
// `MUTATION_SHARDS` is a JSON object of shard counts per package.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SOURCE_FILE = /\.ts$/;
const NOT_MUTATED = /(__tests__\/|\.test\.ts$|\.test-d\.ts$|\/migrations\/)/;

const incrementalPath = (packageName) =>
  join("packages", packageName, ".stryker", "incremental.json");

function readIncremental(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

/** Tests run per source file (paths relative to the package) in a saved result. */
function measuredCost(incremental) {
  const cost = new Map();
  for (const [file, result] of Object.entries(incremental?.files ?? {})) {
    let testsRun = 0;
    for (const mutant of result.mutants)
      testsRun += mutant.testsCompleted ?? mutant.coveredBy?.length ?? 1;
    cost.set(file, testsRun);
  }
  return cost;
}

/**
 * Deals files onto `count` shards, heaviest first onto the lightest shard.
 * `weigh` returns a file's cost; ties break on the path, so a plan is stable.
 */
function balance(files, count, weigh) {
  const shards = Array.from({ length: Math.min(count, files.length) }, () => ({
    load: 0,
    files: [],
  }));
  const ordered = [...files].sort(
    (left, right) => weigh(right) - weigh(left) || left.localeCompare(right),
  );
  for (const file of ordered) {
    const lightest = shards.reduce((best, shard) => (shard.load < best.load ? shard : best));
    lightest.load += weigh(file);
    lightest.files.push(file);
  }
  return shards.map((shard) => shard.files.sort());
}

function sourceFiles(packageName, baseSha) {
  const directory = `packages/${packageName}/src`;
  const listing = baseSha
    ? execFileSync("git", [
        "diff",
        "--name-only",
        "--diff-filter=AMR",
        `${baseSha}...HEAD`,
        "--",
        directory,
      ])
    : execFileSync("git", ["ls-files", directory]);
  return listing
    .toString()
    .split("\n")
    .filter((path) => SOURCE_FILE.test(path) && !NOT_MUTATED.test(path))
    .map((path) => path.slice(`packages/${packageName}/`.length));
}

function plan() {
  const shardCounts = JSON.parse(process.env.MUTATION_SHARDS);
  const include = [];
  for (const [packageName, count] of Object.entries(shardCounts)) {
    const files = sourceFiles(packageName, process.env.BASE_SHA);
    const cost = measuredCost(readIncremental(incrementalPath(packageName)));
    const sourceLength = (file) => statSync(join("packages", packageName, file)).size;
    // Tests run per byte of the measured files prices a file with no result yet.
    let measuredTests = 0;
    let measuredBytes = 0;
    for (const [file, testsRun] of cost) {
      if (!existsSync(join("packages", packageName, file))) continue;
      measuredTests += testsRun;
      measuredBytes += sourceLength(file);
    }
    const testsPerByte = measuredBytes > 0 ? measuredTests / measuredBytes : 1;
    const weigh = (file) => cost.get(file) ?? sourceLength(file) * testsPerByte;
    balance(files, count, weigh).forEach((shardFiles, shard) =>
      include.push({ package: packageName, shard, mutate: shardFiles.join(",") }),
    );
  }
  process.stdout.write(`${JSON.stringify({ include })}\n`);
}

/**
 * Folds shard results over the saved report. A shard's report also carries the
 * saved copies of files it did not mutate, so only the files it mutated are
 * taken from it. Files that no longer exist are dropped, so the saved report
 * does not grow with deleted code.
 */
function mergeIncremental(saved, shardResults, fileExists) {
  const merged = saved ?? { ...shardResults[0].report, files: {}, testFiles: {} };
  for (const { report, mutatedFiles } of shardResults) {
    for (const file of mutatedFiles) {
      if (report.files[file]) merged.files[file] = report.files[file];
    }
    merged.testFiles = { ...merged.testFiles, ...report.testFiles };
  }
  for (const key of ["files", "testFiles"]) {
    merged[key] = Object.fromEntries(
      Object.entries(merged[key]).filter(([file]) => fileExists(file)),
    );
  }
  return merged;
}

/**
 * Reads `<shard-results-directory>/<package>--<shard>/`, each holding the
 * shard's `incremental.json` and `mutated-files.txt` (its comma-separated
 * `--mutate` list).
 */
function merge(shardDirectory) {
  const byPackage = new Map();
  for (const entry of readdirSync(shardDirectory)) {
    const [packageName] = entry.split("--");
    const results = byPackage.get(packageName) ?? [];
    results.push({
      report: JSON.parse(readFileSync(join(shardDirectory, entry, "incremental.json"), "utf8")),
      mutatedFiles: readFileSync(join(shardDirectory, entry, "mutated-files.txt"), "utf8")
        .trim()
        .split(","),
    });
    byPackage.set(packageName, results);
  }
  for (const [packageName, results] of byPackage) {
    const path = incrementalPath(packageName);
    const fileExists = (file) => existsSync(join("packages", packageName, file));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(mergeIncremental(readIncremental(path), results, fileExists)),
    );
    process.stdout.write(`${packageName}: merged ${results.length} shard result(s)\n`);
  }
}

const [command, argument] = process.argv.slice(2);
if (command === "plan") plan();
else if (command === "merge") merge(argument);
else throw new Error("usage: mutation-shards.mjs plan | merge <shard-results-directory>");
