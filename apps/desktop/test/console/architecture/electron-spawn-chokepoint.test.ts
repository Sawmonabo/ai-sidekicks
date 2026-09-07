// One module spawns Electron, and this is what says so.
//
// The rule: no file under `apps/desktop/test/**` reaches the asynchronous
// `spawn` of `node:child_process` except `test/helpers/electron-child.ts`. A
// second spawn site is a second child lifetime nobody owns, which is exactly how
// four Electron processes carrying this package's own `sidekicks-gc-test-*`
// profile prefix were found reparented to init long after their run had finished.
//
// The reach itself is read out of the PARSE by `child-process-reach.ts`, which
// carries the reasons each spelling is admitted or refused. This file is the
// other half: the tree scan, the planted controls, and the superseded reader they
// are measured against — because a control that only asserts the new reader fires
// would pass over a reader that fires on everything.
//
// Playwright's `_electron.launch` is not a `spawn` and is not read here — it
// reaches `node:child_process` inside the Playwright package rather than inside
// this one, so no arm below can see it. It has a chokepoint of its own, and one
// this gate cannot make: `playwright-launch-chokepoint.test.ts` names the single
// launch site and asserts it CALLS the settle-time door rather than naming it.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isTypeScriptModuleFileName } from "../console-source-classification.js";
import { consoleSourceModules } from "../console-source-modules.js";
import { reachesAsynchronousSpawn } from "./child-process-reach.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = path.resolve(HERE, "..", "..");

/** The one module allowed to reach `spawn`, relative to `test/`. */
const SPAWN_CHOKEPOINT = path.join("helpers", "electron-child.ts");

/**
 * This file, which carries every planted control below as literal source text.
 *
 * NOT SUBTRACTED FROM THE SCAN, and that is a property of the reader rather than
 * a decision made here: a planted shape inside a string literal is a string
 * literal to the parser, so this file's own controls cannot make it look like a
 * spawner. The regex this replaced could not tell the two apart and needed an
 * exemption for exactly that reason — and an exemption is a hole that a real
 * second spawner can one day fall into. The case below asserts the difference.
 */
const CONTROL_FIXTURE_FILE = path.join(
  "console",
  "architecture",
  "electron-spawn-chokepoint.test.ts",
);

/**
 * The reader this file replaced, kept as the foil the controls are measured against.
 *
 * Not a second implementation of the rule — it is the SUPERSEDED one, and its
 * only use is the case that shows what it could not see. A control that merely
 * asserts the new reader fires would pass over a reader that fires on
 * everything; a control that also asserts the old one did NOT fire is the one
 * that says the walk bought something.
 */
const NAMED_IMPORT_CLAUSE = /import\s*\{([^}]*)\}\s*from\s*["']node:child_process["']/g;

function supersededNamedImportReader(source: string): boolean {
  for (const clause of source.matchAll(NAMED_IMPORT_CLAUSE)) {
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

/**
 * The extension test this walk used to apply, kept as the foil below.
 *
 * `.ts` and `.tsx` and nothing else, which is two of the four spellings a
 * TypeScript module in this package actually has — so a `.mts` helper reaching
 * `spawn` was never a candidate for the claim this file makes, and a set that
 * omits a file cannot report it. `console-source-modules.ts` owns the real set;
 * this stays only to show what it bought.
 */
const SUPERSEDED_EXTENSION_TEST = /\.tsx?$/;

/**
 * Every TypeScript module under `root`, as paths relative to `root`.
 *
 * THE PACKAGE'S ONE WALK, and this gate used to carry a second: a `readdirSync`
 * recursion admitting a file by `isTypeScriptModuleFileName` alone, which answers
 * by EXTENSION and so admits `.d.ts` where the shared walk subtracts declarations
 * because nothing in one runs. A declaration naming `spawn` was therefore a second
 * spawner to this gate and no source at all to every other, with nothing reporting
 * the difference. `tests: true` because every module under this root is one.
 */
function typeScriptModulesUnder(root: string): readonly string[] {
  return consoleSourceModules({ roots: [root], tests: true }).map((module) => module.relativePath);
}

function readTestSource(relativePath: string): string {
  return readFileSync(path.join(TEST_ROOT, relativePath), "utf8");
}

function fileReachesSpawn(relativePath: string): boolean {
  return reachesAsynchronousSpawn(readTestSource(relativePath), relativePath);
}

/**
 * The reaches the named-import reader could not see, each one a real spelling.
 *
 * Each entry carries its own reason rather than a positional roster above the
 * list, because a roster that numbers its members is a claim that goes stale the
 * next time a spelling is inserted in the middle — which is what happened here:
 * the sentence this replaced still called the sixth entry the builtin loader
 * after the default-binding arm had been added ahead of it.
 */
const REACHES_INVISIBLE_TO_THE_REGEX: readonly string[] = [
  // The ordinary CommonJS-interop idiom.
  'import * as childProcess from "node:child_process";\nchildProcess.spawn("electron");',
  // What a module writes when it needs the loader inside a function.
  'const { spawn } = require("node:child_process");',
  // The same module under the prefix-less specifier.
  'import { spawn } from "child_process";',
  // The deferred load.
  'const childProcess = await import("node:child_process");',
  // The escape a rule that knew only `require` would leave open.
  'const childProcess = createRequire(import.meta.url)("node:child_process");',
  // A default binding of a CommonJS module is the module object under interop.
  'import childProcess from "node:child_process";',
  // The builtin-loader arm: no `import`, no `require`, and a property-access
  // callee that the identifier arms alone reported clean while it spawned.
  'const childProcess = process.getBuiltinModule("node:child_process");',
  // The SAME loader written in brackets. TypeScript parses this callee as an
  // element access rather than a property access, so a reader admitting only the
  // dotted form reported it clean — the identifier-only hole one indirection
  // along, and the spelling a module writes when it means not to be read.
  'const childProcess = process["getBuiltinModule"]("node:child_process");',
  // The same bracketing on a loader whose bare spelling is an identifier, so the
  // arm is shown to read the NAME rather than one blessed object.
  'const childProcess = module["require"]("child_process");',
  // The import-equals arm: TypeScript's own CommonJS binding form, whose
  // `require` is SYNTAX rather than a call — so neither the import-clause arm
  // nor the call arm saw it, and a helper written this way spawned under a
  // green check. `.cts` is where a module writes it by default, and the planted
  // walk below drives both extensions.
  'import childProcess = require("node:child_process");\nchildProcess.spawn("electron");',
  // The same declaration wearing the export keyword, which re-exports the
  // binding as well as taking it — one node kind, so one arm covers both.
  'export import childProcess = require("child_process");',
  // The re-export arm: none writes `import`, so the superseded reader saw nothing.
  'export { spawn } from "node:child_process";',
  'export { spawn as launch } from "node:child_process";',
  'export * from "node:child_process";',
  'export * as childProcess from "child_process";',
];

/** Shapes that name the module or the word and start no process. */
const REACHES_THAT_ARE_NOT_ONE: readonly string[] = [
  'import { spawnSync } from "node:child_process";',
  'import { spawnSync, type ChildProcess } from "node:child_process";',
  'import type { spawn } from "node:child_process";',
  'import { type spawn } from "node:child_process";',
  'import "node:child_process";',
  'export type { spawn } from "node:child_process";',
  'export { type spawn } from "node:child_process";',
  'export { spawnSync } from "node:child_process";',
  'export { spawn } from "./electron-child.js";',
  "const spawn = launcher.spawn.bind(launcher);",
  // The builtin loader still keys on the SPECIFIER, so another module is not one.
  'const buffer = process.getBuiltinModule("node:buffer");',
  'const buffer = process["getBuiltinModule"]("node:buffer");',
  // The residual the reader names rather than hides: a subscript that is not a
  // literal says no loader name in the text, and deciding what `loaderName`
  // holds is the binding resolution this reader does not do.
  'const childProcess = process[loaderName]("node:child_process");',
  'const advice = "import { spawn } from \\"node:child_process\\"";',
  // The import-equals arms that reach no module: a type-only one starts no
  // process, and an entity-name reference is an alias for a local namespace
  // rather than a load — it carries no specifier for the rule to key on.
  'import type childProcess = require("node:child_process");',
  "import childProcess = NodeJS.ChildProcessNamespace;",
  'import buffer = require("node:buffer");',
];

/** A module whose only job is to reach the asynchronous spawn, for the planted walk. */
const PLANTED_SPAWNER_SOURCE = 'import { spawn } from "node:child_process";\nspawn("electron");\n';

/**
 * The same spawner written in TypeScript's import-equals form.
 *
 * Planted under two extensions below because the parse home derives its script
 * kind from the file NAME, so "the reader answers the same for a `.cts` helper"
 * is a property of that derivation rather than a restatement of the case above.
 * `.cts` is the extension a module writing this form ordinarily carries.
 */
const PLANTED_IMPORT_EQUALS_SPAWNER_SOURCE =
  'import childProcess = require("node:child_process");\nchildProcess.spawn("electron");\n';

describe("every Electron spawn under test/ goes through one owner", () => {
  const files = typeScriptModulesUnder(TEST_ROOT);

  it("finds a test tree to read at all", () => {
    // The zero-match failure this tier requires of every tripwire: a rule that
    // scanned nothing would report clean forever.
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain(SPAWN_CHOKEPOINT);
    expect(files).toContain(CONTROL_FIXTURE_FILE);
  });

  it("names exactly one module that reaches the asynchronous spawn", () => {
    const spawners = files.filter(fileReachesSpawn);
    expect(
      spawners,
      "a second module under test/ reaches `spawn` — route it through " +
        "`spawnManagedElectronChild` so the child's lifetime is bound to the test",
    ).toStrictEqual([SPAWN_CHOKEPOINT]);
  });

  it("scans this file too, because a quoted reach is not a reach", () => {
    // Why the case above needs no exemption list. Every control in this file is
    // literal source text, and the parser sees literals; the regex could not,
    // which is why it needed this file subtracted — and a subtraction is a hole
    // a real second spawner can fall into. The foil firing here is the proof
    // that the controls really are the text they claim to be.
    expect(fileReachesSpawn(CONTROL_FIXTURE_FILE)).toBe(false);
    expect(
      supersededNamedImportReader(readTestSource(CONTROL_FIXTURE_FILE)),
      "the planted controls are no longer literal import text, so they prove nothing",
    ).toBe(true);
  });

  it("catches every spelling the named-import reader reported clean", () => {
    for (const planted of REACHES_INVISIBLE_TO_THE_REGEX) {
      expect(reachesAsynchronousSpawn(planted, "planted.ts"), planted).toBe(true);
    }
    // The other half of the same control: each of these was invisible to the
    // reader this replaced, so the walk is what closed them and not the tree
    // happening to be clean.
    for (const planted of REACHES_INVISIBLE_TO_THE_REGEX) {
      expect(supersededNamedImportReader(planted), planted).toBe(false);
    }
  });

  it("fails on a planted named import, so the clean result above is not vacuous", () => {
    expect(reachesAsynchronousSpawn('import { spawn } from "node:child_process";', "p.ts")).toBe(
      true,
    );
    expect(
      reachesAsynchronousSpawn('import { spawn, spawnSync } from "node:child_process";', "p.ts"),
    ).toBe(true);
    expect(
      reachesAsynchronousSpawn(
        'import {\n  spawnSync,\n  spawn,\n  type ChildProcess,\n} from "node:child_process";',
        "p.ts",
      ),
    ).toBe(true);
    expect(
      reachesAsynchronousSpawn('import { spawn as launch } from "node:child_process";', "p.ts"),
    ).toBe(true);
  });

  it("reads a builtin loader through the object that carries it", () => {
    // `process.getBuiltinModule` is Node 22's own way to a builtin, and it is
    // reachable from any module without an import of any kind — so a file could
    // read clean here and still put every export of `node:child_process` in its
    // hands. The whole-module callee set is read against the NAME, which is why
    // `module.require` falls in with it rather than needing a second list.
    expect(
      reachesAsynchronousSpawn(
        'const { spawn } = process.getBuiltinModule("child_process");',
        "p.ts",
      ),
    ).toBe(true);
    expect(reachesAsynchronousSpawn('module.require("node:child_process");', "p.ts")).toBe(true);
  });

  it("reads that loader through a bracketed subscript as well as a dot", () => {
    // `process["getBuiltinModule"]` is the same property under a different node
    // kind, and the dotted arm alone reported it clean while it spawned. The
    // name is what is read, so a no-substitution template says it as plainly as
    // a quoted string, and a subscript that names no loader still says nothing.
    expect(
      reachesAsynchronousSpawn(
        'const { spawn } = process["getBuiltinModule"]("child_process");',
        "p.ts",
      ),
    ).toBe(true);
    const template = "const { spawn } = process[`getBuiltinModule`](`node:child_process`);";
    expect(reachesAsynchronousSpawn(template, "p.ts")).toBe(true);
    expect(reachesAsynchronousSpawn('module["require"]("node:child_process");', "p.ts")).toBe(true);
    expect(reachesAsynchronousSpawn('process["cwd"]("node:child_process");', "p.ts")).toBe(false);
  });

  it("still clears the forms that cannot start a process", () => {
    for (const planted of REACHES_THAT_ARE_NOT_ONE) {
      expect(reachesAsynchronousSpawn(planted, "planted.ts"), planted).toBe(false);
    }
  });

  it("walks the module extensions a TypeScript module has, and no declaration", () => {
    // THE FINDING, driven end to end rather than asserted about a regex. The walk
    // is run over a planted tree holding one spawner per module-system extension,
    // and the foil is run over the same names: the reader was never the hole —
    // it reports both of these as spawners — the SET was, and a file the walk
    // never collected could reach `spawn` under a green check forever.
    //
    // The declaration is the other half — the disagreement the local walk carried.
    // Both foils are asserted: the file test that admits the `.d.ts` name, and the
    // reader that cannot tell the two texts apart. So the exclusion is the WALK's.
    const plantedRoot = mkdtempSync(path.join(tmpdir(), "sidekicks-spawn-walk-"));
    try {
      const plantedNames: readonly string[] = ["planted-spawner.mts", "planted-spawner.cts"];
      const declarationName = "planted-spawner.d.ts";
      mkdirSync(path.join(plantedRoot, "helpers"));
      for (const name of [...plantedNames, declarationName]) {
        writeFileSync(path.join(plantedRoot, "helpers", name), PLANTED_SPAWNER_SOURCE, "utf8");
      }
      // A non-module file in the same directory, so the walk is shown to be
      // selecting rather than collecting everything it finds.
      writeFileSync(path.join(plantedRoot, "helpers", "planted-notes.md"), "not source\n", "utf8");

      expect([...typeScriptModulesUnder(plantedRoot)].sort()).toStrictEqual(
        [...plantedNames].map((name) => path.join("helpers", name)).sort(),
      );
      expect(isTypeScriptModuleFileName(declarationName)).toBe(true);
      expect(reachesAsynchronousSpawn(PLANTED_SPAWNER_SOURCE, declarationName)).toBe(true);
      for (const name of plantedNames) {
        expect(reachesAsynchronousSpawn(PLANTED_SPAWNER_SOURCE, name), name).toBe(true);
        expect(
          SUPERSEDED_EXTENSION_TEST.test(name),
          `${name} was already inside the walk, so this control proves nothing`,
        ).toBe(false);
      }
    } finally {
      rmSync(plantedRoot, { recursive: true, force: true });
    }
  });

  it("reads the import-equals binding under both extensions a module writes it in", () => {
    // THE FINDING this case was added for, driven over a planted tree rather
    // than asserted about a node kind. `import childProcess = require(...)` is
    // neither an import CLAUSE nor a CALL — its `require` is syntax, and the
    // specifier hangs off an external module reference the other two arms never
    // look at — so a helper written this way was collected by the walk, read by
    // the reader, and reported clean while it spawned Electron.
    //
    // Both extensions are planted because the parse home derives its script kind
    // from the file name: a `.cts` helper is where this form is ordinarily
    // written, and a reader that answered only for `.ts` would leave the
    // idiomatic spelling of the hole open.
    const plantedRoot = mkdtempSync(path.join(tmpdir(), "sidekicks-import-equals-"));
    try {
      const plantedNames: readonly string[] = ["planted-loader.ts", "planted-loader.cts"];
      mkdirSync(path.join(plantedRoot, "helpers"));
      for (const name of plantedNames) {
        writeFileSync(
          path.join(plantedRoot, "helpers", name),
          PLANTED_IMPORT_EQUALS_SPAWNER_SOURCE,
          "utf8",
        );
      }

      expect([...typeScriptModulesUnder(plantedRoot)].sort()).toStrictEqual(
        [...plantedNames].map((name) => path.join("helpers", name)).sort(),
      );
      for (const name of plantedNames) {
        expect(
          reachesAsynchronousSpawn(PLANTED_IMPORT_EQUALS_SPAWNER_SOURCE, name),
          `${name} reaches \`spawn\` through TypeScript's import-equals binding and read clean`,
        ).toBe(true);
        // The other half of the same control: the superseded reader saw nothing
        // here either, so this spelling is closed by the walk rather than by the
        // planted text happening to contain a braced import clause.
        expect(supersededNamedImportReader(PLANTED_IMPORT_EQUALS_SPAWNER_SOURCE), name).toBe(false);
      }
    } finally {
      rmSync(plantedRoot, { recursive: true, force: true });
    }
  });
});
