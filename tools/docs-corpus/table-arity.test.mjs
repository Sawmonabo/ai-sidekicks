import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "table-arity.mjs");

function runOn(markdown) {
  const dir = mkdtempSync(path.join(tmpdir(), "arity-"));
  const file = path.join(dir, "t.md");
  writeFileSync(file, markdown);
  return spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8" });
}

test("a well-formed table passes", () => {
  const r = runOn("# T\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n");
  assert.equal(r.status, 0, r.stderr);
});

test("a short row fails with file:line and counts", () => {
  const r = runOn("# T\n\n| a | b |\n| --- | --- |\n| 1 |\n");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /t\.md:5: expected 2 cells, found 1/);
});

test("an escaped pipe is one cell and a fenced table is ignored", () => {
  const r = runOn(
    "| a | b |\n| --- | --- |\n| x \\| y | 2 |\n\n```\n| bad |\n| --- | --- |\n```\n",
  );
  assert.equal(r.status, 0, r.stderr);
});

test("no arguments prints usage and exits 2", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 2);
});

test("an unreadable path prints a one-line message and exits 2", () => {
  const missing = path.join(tmpdir(), "table-arity-does-not-exist.md");
  const r = spawnSync(process.execPath, [SCRIPT, missing], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^table-arity: cannot read .*table-arity-does-not-exist\.md\n$/);
});
