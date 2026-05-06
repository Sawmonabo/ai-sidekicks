// Fixture-loader helper for housekeeper tests.
// Tasks 3.1 and 3.20 of the housekeeper-implementation plan rely on this
// directory layout: each fixture is a subdirectory under __tests__/fixtures/
// containing input/, expected/, args.json, and expected-manifest.json.
// listFixtures returns one descriptor per fixture; readArgs and
// readExpectedManifest deserialize the JSON files; expectFilesEqual walks
// the expected/ tree and asserts byte-equal content against an actual
// directory (typically a tmpdir clone of input/ that runHousekeeper has
// mutated).

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import assert from "node:assert/strict";

export function listFixtures(fixturesDir) {
  return readdirSync(fixturesDir)
    .filter((name) => statSync(join(fixturesDir, name)).isDirectory())
    .sort()
    .map((name) => ({
      name,
      inputDir: join(fixturesDir, name, "input"),
      expectedDir: join(fixturesDir, name, "expected"),
      argsPath: join(fixturesDir, name, "args.json"),
      expectedManifestPath: join(fixturesDir, name, "expected-manifest.json"),
    }));
}

export function readArgs(fixture) {
  return JSON.parse(readFileSync(fixture.argsPath, "utf8"));
}

export function readExpectedManifest(fixture) {
  return JSON.parse(readFileSync(fixture.expectedManifestPath, "utf8"));
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walkFiles(full, base));
    } else {
      out.push(relative(base, full));
    }
  }
  return out.sort();
}

export function expectFilesEqual(actualDir, expectedDir) {
  const expectedFiles = walkFiles(expectedDir);
  for (const rel of expectedFiles) {
    const actualPath = join(actualDir, rel);
    const expectedPath = join(expectedDir, rel);
    assert.ok(existsSync(actualPath), `expected file missing in actual: ${rel}`);
    const actual = readFileSync(actualPath, "utf8");
    const expected = readFileSync(expectedPath, "utf8");
    if (actual !== expected) {
      const actualLines = actual.split("\n");
      const expectedLines = expected.split("\n");
      const maxLines = Math.max(actualLines.length, expectedLines.length);
      let firstDiff = -1;
      for (let i = 0; i < maxLines; i += 1) {
        if (actualLines[i] !== expectedLines[i]) {
          firstDiff = i;
          break;
        }
      }
      assert.fail(
        `file mismatch: ${rel}\n  first differing line ${firstDiff + 1}:\n` +
          `    expected: ${JSON.stringify(expectedLines[firstDiff])}\n` +
          `    actual:   ${JSON.stringify(actualLines[firstDiff])}`,
      );
    }
  }
}
