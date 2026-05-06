// node:test suite for the fixture-loader helper.
// Run via: node --test --experimental-strip-types \
//   .claude/skills/plan-execution/scripts/__tests__/helpers/__tests__/fixture-loader.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listFixtures,
  readArgs,
  readExpectedManifest,
  expectFilesEqual,
} from "../fixture-loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "..", "..", "fixtures");

test("listFixtures returns all immediate subdirectories of fixtures/", () => {
  const fixtures = listFixtures(FIXTURES_DIR);
  assert.ok(fixtures.length >= 1, "expected at least one fixture directory");
  for (const f of fixtures) {
    assert.equal(typeof f.name, "string");
    assert.equal(typeof f.inputDir, "string");
    assert.equal(typeof f.expectedDir, "string");
    assert.equal(typeof f.argsPath, "string");
    assert.equal(typeof f.expectedManifestPath, "string");
  }
});

test("readArgs parses args.json into the runHousekeeper-shaped args", () => {
  const fixture = listFixtures(FIXTURES_DIR).find((f) => f.name === "00-loader-smoke");
  assert.ok(fixture, "00-loader-smoke fixture must exist");
  const args = readArgs(fixture);
  assert.equal(typeof args.prNumber, "number");
});

test("readExpectedManifest parses expected-manifest.json", () => {
  const fixture = listFixtures(FIXTURES_DIR).find((f) => f.name === "00-loader-smoke");
  const manifest = readExpectedManifest(fixture);
  assert.equal(typeof manifest.pr_number, "number");
});

test("expectFilesEqual passes when actual matches expected byte-for-byte", () => {
  const tmp = mkdtempSync(join(tmpdir(), "fixture-loader-eq-"));
  try {
    const expectedDir = join(tmp, "expected");
    const actualDir = join(tmp, "actual");
    mkdirSync(join(expectedDir, "sub"), { recursive: true });
    mkdirSync(join(actualDir, "sub"), { recursive: true });
    writeFileSync(join(expectedDir, "a.md"), "hello\n");
    writeFileSync(join(actualDir, "a.md"), "hello\n");
    writeFileSync(join(expectedDir, "sub/b.txt"), "world\n");
    writeFileSync(join(actualDir, "sub/b.txt"), "world\n");
    expectFilesEqual(actualDir, expectedDir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("expectFilesEqual throws on first differing line", () => {
  const tmp = mkdtempSync(join(tmpdir(), "fixture-loader-diff-"));
  try {
    const expectedDir = join(tmp, "expected");
    const actualDir = join(tmp, "actual");
    mkdirSync(expectedDir, { recursive: true });
    mkdirSync(actualDir, { recursive: true });
    writeFileSync(join(expectedDir, "a.md"), "line1\nline2\nline3\n");
    writeFileSync(join(actualDir, "a.md"), "line1\nDIFFERENT\nline3\n");
    assert.throws(() => expectFilesEqual(actualDir, expectedDir), /first differing line 2/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
