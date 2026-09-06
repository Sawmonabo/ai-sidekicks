// One module spawns Electron, and this is what says so.
//
// The rule: no file under `apps/desktop/test/**` imports `spawn` from
// `node:child_process` except `test/helpers/electron-child.ts`. A second spawn
// site is a second child lifetime nobody owns, which is exactly how four
// Electron processes carrying this package's own `sidekicks-gc-test-*` profile
// prefix were found reparented to init long after their run had finished.
//
// WHY THE IMPORT AND NOT THE CALL
//
// A rule keyed on the call would have to decide whether a given `spawn(...)`
// launches Electron — through a variable holding a binary path, through
// `xvfb-run` wrapping it, through a helper two files away. That is a judgment,
// and a tripwire that makes judgments is a tripwire that can be argued with. The
// import is a fact: a module that cannot name `spawn` cannot start a process
// whose lifetime this package does not already own.
//
// `spawnSync` is deliberately untouched. It cannot orphan anything — it returns
// only once its child is gone — and three architecture tests plus
// `process-tree.ts` use it. Narrowing the ban to the asynchronous form is what
// keeps this rule about lifetimes rather than about a substring.
//
// Playwright's `_electron.launch` is not a `spawn` and is not banned here. It
// has its own chokepoint (`withLaunchedConsole` is the one way in, and
// `launchConsole` is not exported) and it reaches the SAME settle-time door,
// `disposeWhenTestFinishes`, which the last case below asserts rather than
// assumes.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = path.resolve(HERE, "..", "..");

/** The one module allowed to name `spawn`, relative to `test/`. */
const SPAWN_CHOKEPOINT = path.join("helpers", "electron-child.ts");

/** The launcher that must reach the same settle-time door, relative to `test/`. */
const PLAYWRIGHT_LAUNCHER = path.join("console", "electron-harness.ts");

/**
 * This file, which carries planted import text as its own negative control.
 *
 * Subtracted from the scan rather than dodged by obfuscating the controls: a
 * control written so the detector cannot see it is not a control. The
 * subtraction is itself asserted below, so it can never quietly become the
 * reason a real second spawner passes.
 */
const CONTROL_FIXTURE_FILE = path.join(
  "console",
  "architecture",
  "electron-spawn-chokepoint.test.ts",
);

/** Every named-import clause taken from `node:child_process`, brace body captured. */
const CHILD_PROCESS_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["']node:child_process["']/g;

/**
 * Whether a source text imports the ASYNCHRONOUS `spawn` from `node:child_process`.
 *
 * Decided per SPECIFIER rather than by a substring, which is the whole
 * discrimination this rule rests on: `spawnSync` contains `spawn` and is
 * deliberately allowed, and a local identifier named `spawn` — a Playwright
 * option object, a property on a driver contract — is not an import at all.
 */
function importsAsynchronousSpawn(source: string): boolean {
  for (const clause of source.matchAll(CHILD_PROCESS_IMPORT)) {
    const braceBody = clause[1];
    if (braceBody === undefined) continue;
    const specifiers = braceBody.split(",").map((specifier) => specifier.trim());
    if (
      specifiers.some((specifier) => specifier === "spawn" || specifier.startsWith("spawn as "))
    ) {
      return true;
    }
  }
  return false;
}

/** Every `.ts` / `.tsx` file under `test/`, as paths relative to `test/`. */
function testSourceFiles(directory: string = TEST_ROOT): string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collected.push(...testSourceFiles(absolute));
      continue;
    }
    if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      collected.push(path.relative(TEST_ROOT, absolute));
    }
  }
  return collected;
}

function fileImportsSpawn(relativePath: string): boolean {
  return importsAsynchronousSpawn(readFileSync(path.join(TEST_ROOT, relativePath), "utf8"));
}

describe("every Electron spawn under test/ goes through one owner", () => {
  const files = testSourceFiles();

  it("finds a test tree to read at all", () => {
    // The zero-match failure this tier requires of every tripwire: a rule that
    // scanned nothing would report clean forever.
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain(SPAWN_CHOKEPOINT);
  });

  it("carries its own planted import text, which is why it is subtracted", () => {
    // If this ever reads false the controls below have stopped being literal
    // import text, and the subtraction on the next case is hiding nothing —
    // which would also mean the detector was never proven against this tree.
    expect(files).toContain(CONTROL_FIXTURE_FILE);
    expect(fileImportsSpawn(CONTROL_FIXTURE_FILE)).toBe(true);
  });

  it("names exactly one module that imports the asynchronous spawn", () => {
    const spawners = files
      .filter((relativePath) => relativePath !== CONTROL_FIXTURE_FILE)
      .filter(fileImportsSpawn);
    expect(
      spawners,
      "a second module under test/ imports `spawn` — route it through " +
        "`spawnManagedElectronChild` so the child's lifetime is bound to the test",
    ).toStrictEqual([SPAWN_CHOKEPOINT]);
  });

  it("fails on a planted import, so the clean result above is not vacuous", () => {
    // The negative control. Three shapes a real regression takes, and the
    // `spawnSync` line that must NOT trip — the discrimination the rule rests on.
    expect(importsAsynchronousSpawn('import { spawn } from "node:child_process";')).toBe(true);
    expect(importsAsynchronousSpawn('import { spawn, spawnSync } from "node:child_process";')).toBe(
      true,
    );
    expect(
      importsAsynchronousSpawn(
        'import {\n  spawnSync,\n  spawn,\n  type ChildProcess,\n} from "node:child_process";',
      ),
    ).toBe(true);
    expect(importsAsynchronousSpawn('import { spawn as launch } from "node:child_process";')).toBe(
      true,
    );
    expect(importsAsynchronousSpawn('import { spawnSync } from "node:child_process";')).toBe(false);
    expect(
      importsAsynchronousSpawn(
        'import { spawnSync, type ChildProcess } from "node:child_process";',
      ),
    ).toBe(false);
    // Not an import of anything: the shape a call-keyed rule would have to judge.
    expect(importsAsynchronousSpawn("const spawn = launcher.spawn.bind(launcher);")).toBe(false);
  });

  it("holds the Playwright launcher to the same settle-time door", () => {
    // It spawns nothing here, so the rule above cannot reach it — and it has the
    // identical hole: its close runs in the body's own settlement, and vitest's
    // per-test timeout does not run that.
    const launcher = readFileSync(path.join(TEST_ROOT, PLAYWRIGHT_LAUNCHER), "utf8");
    expect(
      launcher.includes("disposeWhenTestFinishes"),
      "`withLaunchedConsole` no longer registers a settle-time close — a tier that " +
        "overruns its own budget will leave a real Electron and its profile behind",
    ).toBe(true);
  });
});
