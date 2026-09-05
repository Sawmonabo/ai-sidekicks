// Every source-text gate reads the same tree, and the build says so.
//
// WHY THIS FILE EXISTS. Gates in this directory make claims of the form "no module in
// the console does X". Each claim is only as good as the SET it quantifies over, and
// that set is a directory walk with an opinion about what counts as source. Written
// per gate, those opinions drift silently: before this chokepoint there were three
// copies plus the shared helper, and they already disagreed — two excluded
// `.test-support.*` and one did not, so `bridge/fixture-bridge.test-support.ts` was
// inside one gate's universe and outside another's, with nothing anywhere reporting
// the difference. A gate that scans a smaller tree than its sentence claims is not a
// weaker gate; it is a gate that reports clean for the wrong reason.
//
// THE UNIVERSE IS EVERY MODULE UNDER `test/console/`, MODELS INCLUDED, and it was not
// always. It used to be this directory's `*.test.ts` files, which left three classes
// of module outside a claim that reads as if it covered them: a `*-census.ts` model
// beside its gate, a harness, and every other tier — `assets/generated-tokens.test.ts`
// walked the console for stylesheets from the tier next door and nothing reported it,
// which is precisely the shape this file exists to catch. A chokepoint scoped to the
// files that happen to end in `.test.ts` is a chokepoint a walk escapes by living in
// the model beside one.
//
// So `test/console/console-source-modules.ts` owns the walk — modules through
// `consoleSourceModules`, stylesheets through `consoleStylesheets`, its `tests` option
// expressing the one legitimate divergence — and this file is what keeps a further
// walk from appearing beside it. It is the same posture the timer and byte-scaling
// chokepoints take toward the console's own source: name the modules that may do the
// thing, and assert nothing else does.
//
// THE INSTRUMENT IS THE PARSER over source text, and it has to be: "this gate draws its
// module set from the shared walk" is a claim about how a module is written, which no
// type and no runtime assertion inside those modules can reach. The reading lives in
// `source-walk-census.ts` beside this file, so every predicate below can be driven
// against planted text as well as against the real tree.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CONSOLE_DIRECTORY,
  CONSOLE_SOURCE_ROOTS,
  consoleSourceModules,
  consoleStylesheets,
  moduleNamed,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import {
  directoryWalkImports,
  importsSharedWalk,
  pathLiteralsIn,
  readerOffenders,
  readsAFile,
  reachesRendererSource,
  walkOffenders,
  type TestTierModuleText,
} from "./source-walk-census.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST_TIER_DIRECTORY = resolve(HERE, "..");

/**
 * The two modules that may reach renderer source and walk it anyway.
 *
 * The shared walk is the walk, and this gate is the one file where the forbidden
 * import has to appear so the needles can be driven against real code. Both are
 * asserted below to still TRIP those needles, so neither admission can outlive its
 * cause: a rename of `readdirSync` would leave two constants admitting modules that
 * no longer match, and the clean result would stop meaning anything.
 */
const MODULES_THAT_MAY_WALK: readonly string[] = [
  "console-source-modules.ts",
  "architecture/source-walk-chokepoint.test.ts",
];

/** Every module in the console's test tier, models and harnesses included. */
function testTierModules(): readonly TestTierModuleText[] {
  return consoleSourceModules({ roots: [TEST_TIER_DIRECTORY], tests: true }).map((module) => ({
    relativePath: module.relativePath.split("\\").join("/"),
    source: readConsoleSourceModule(module),
  }));
}

describe("source-walk chokepoint — one walk under every source-text claim", () => {
  const modules = testTierModules();
  const named = (relativePath: string): TestTierModuleText => {
    const found = modules.find((module) => module.relativePath === relativePath);
    if (found === undefined) {
      throw new Error(`the tier scan did not reach ${relativePath}`);
    }
    return found;
  };

  it("finds the whole tier to scan, and not just this directory", () => {
    // Without this a wrong root would scan nothing and every claim below would pass
    // over the empty set. The three names are one per class the widening added: a
    // gate in this directory, a model beside one, and a gate in another tier.
    expect(modules.length).toBeGreaterThan(40);
    expect(modules.map((module) => module.relativePath)).toEqual(
      expect.arrayContaining([
        "architecture/timer-chokepoint.test.ts",
        "architecture/barrel-census.ts",
        "assets/generated-tokens.test.ts",
      ]),
    );
  });

  it("no module that reaches renderer source walks a directory of its own", () => {
    expect(walkOffenders(modules, MODULES_THAT_MAY_WALK)).toStrictEqual([]);
  });

  it("every module that reads a file either uses the shared walk or reaches no renderer source", () => {
    // The subject is every module that reads a FILE at all, decidable from the read
    // rather than from the module's compliance. The shape this catches is a module
    // that hard-codes a list of console paths and reads them itself — a further
    // opinion about what counts as source wearing a different shape, which names no
    // walk and would sit outside a claim subjected on walking.
    expect(readerOffenders(modules, MODULES_THAT_MAY_WALK)).toStrictEqual([]);
  });

  it("finds modules on both sides of the scope, so neither claim is vacuous", () => {
    // The scope is what replaced two hand-written admission lists, so both of its
    // sides have to have members or the claims above quantify over nothing. Modules
    // that walk and do NOT reach renderer source are the tier's own file
    // enumerations — which project owns a test file, which bounded wait a launched
    // body declares, what a release build contains — and they are the reason the
    // claims are scoped rather than absolute.
    const reaching = modules.filter((module) =>
      reachesRendererSource(module.source, module.relativePath),
    );
    const walkingOutsideIt = modules.filter(
      (module) =>
        !reachesRendererSource(module.source, module.relativePath) &&
        directoryWalkImports(module.source, module.relativePath).length > 0,
    );
    expect(reaching.length).toBeGreaterThan(1);
    expect(walkingOutsideIt.length).toBeGreaterThan(1);
    // The floor names readers rather than counting them: a count pinned to today's
    // tree moves every time a gate is rebound onto the walk. These two read a
    // harness and the CI workflow, reach no renderer path, and are exactly the
    // escape the reader claim derives.
    const readers = modules
      .filter((module) => readsAFile(module.source, module.relativePath))
      .map((module) => module.relativePath);
    expect(readers).toEqual(
      expect.arrayContaining([
        "architecture/ci-tier-coverage.test.ts",
        "architecture/cleanup-disposition.test.ts",
      ]),
    );
  });

  it("negative control: a planted model with a private walk is an offence", () => {
    // The class the old universe could not see at all. It is a `.ts` model, not a
    // `.test.ts` gate, and it composes the renderer path in ONE literal — the two
    // properties that let `assets/generated-tokens.test.ts` walk the console
    // unreported for as long as it did.
    const planted: TestTierModuleText = {
      relativePath: "architecture/planted-census.ts",
      source: [
        'import { readdirSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        'const root = fileURLToPath(new URL("../../../src/renderer/src/console", import.meta.url));',
        "export const entries = readdirSync(root, { recursive: true });",
      ].join("\n"),
    };
    expect(walkOffenders([planted], MODULES_THAT_MAY_WALK)).toStrictEqual([
      "architecture/planted-census.ts: readdirSync",
    ]);
    // And the same model drawing its set from the shared walk is not an offence.
    expect(
      walkOffenders(
        [
          {
            relativePath: "architecture/planted-census.ts",
            source: [
              'import { consoleStylesheets, CONSOLE_DIRECTORY } from "../console-source-modules.js";',
              "export const sheets = consoleStylesheets({ roots: [CONSOLE_DIRECTORY] });",
            ].join("\n"),
          },
        ],
        MODULES_THAT_MAY_WALK,
      ),
    ).toStrictEqual([]);
  });

  it("negative control: a planted reader that hard-codes console paths is an offence", () => {
    const planted: TestTierModuleText = {
      relativePath: "architecture/planted-reader.test.ts",
      source: [
        'import { readFileSync } from "node:fs";',
        'import { resolve } from "node:path";',
        'const one = resolve(HERE, "..", "..", "src", "renderer", "src", "console", "core.ts");',
        'export const text = readFileSync(one, "utf8");',
      ].join("\n"),
    };
    expect(readerOffenders([planted], MODULES_THAT_MAY_WALK)).toStrictEqual([
      "architecture/planted-reader.test.ts",
    ]);
    // A reader that reaches the BUILD OUTPUT instead is outside the claim, and this
    // is the case the one-literal rule had to be made adjacent-only to preserve.
    expect(
      readerOffenders(
        [
          {
            relativePath: "budget/planted-build-reader.test.ts",
            source: [
              'import { readFileSync } from "node:fs";',
              'import { NAMES } from "../../../src/renderer/src/console/core/fixture-globals.js";',
              'const built = resolve(HERE, "out/renderer", "index.js");',
              'export const text = [NAMES, readFileSync(built, "utf8")];',
            ].join("\n"),
          },
        ],
        MODULES_THAT_MAY_WALK,
      ),
    ).toStrictEqual([]);
  });

  it("negative control: the admitted modules still trip the needles they are admitted for", () => {
    for (const relativePath of MODULES_THAT_MAY_WALK) {
      const module = named(relativePath);
      expect(directoryWalkImports(module.source, relativePath)).toContain("readdirSync");
      expect(reachesRendererSource(module.source, relativePath)).toBe(true);
    }
  });

  it("negative control: the walk scan reads an import and not a mention of one", () => {
    expect(directoryWalkImports('import { readdirSync } from "node:fs";', "probe.ts")) //
      .toStrictEqual(["readdirSync"]);
    // The three spellings the text needles missed, each measured passing them.
    expect(
      directoryWalkImports('import { readdirSync as listEntries } from "node:fs";', "probe.ts"),
    ).toStrictEqual(["readdirSync"]);
    expect(directoryWalkImports('import { globSync } from "node:fs";', "probe.ts")) //
      .toStrictEqual(["globSync"]);
    expect(directoryWalkImports('import * as fs from "node:fs";', "probe.ts")) //
      .toStrictEqual(["* as fs"]);
    // And a walk named in prose, or a file read that is not a walk, is not an offence.
    expect(
      directoryWalkImports("// this file used to carry its own `readdirSync(root)`", "probe.ts"),
    ).toStrictEqual([]);
    expect(directoryWalkImports('import { readFileSync } from "node:fs";', "probe.ts")) //
      .toStrictEqual([]);
  });

  it("negative control: the predicates separate their sides", () => {
    expect(readsAFile('import { readFileSync } from "node:fs";', "p.ts")).toBe(true);
    expect(readsAFile('import { readFile } from "node:fs/promises";', "p.ts")).toBe(true);
    expect(readsAFile("// a gate that reads a file names the shared walk", "p.ts")).toBe(false);
    // A composed renderer path reaches; the same words in prose do not, which is the
    // whole reason the scope is read from string literals through the parser.
    expect(
      reachesRendererSource('const at = resolve(HERE, "..", "renderer", "src");', "p.ts"),
    ).toBe(true);
    expect(reachesRendererSource("// the renderer tier is selected twice", "p.ts")).toBe(false);
    expect(
      reachesRendererSource('const harness = resolve(HERE, "..", "electron-harness.ts");', "p.ts"),
    ).toBe(false);
    // One literal reaches when its segments are adjacent, and not when they are not.
    expect(reachesRendererSource('const at = new URL("../../src/renderer/src");', "p.ts")).toBe(
      true,
    );
    expect(reachesRendererSource('const at = join(root, "out/renderer");', "p.ts")).toBe(false);
    // An import specifier is resolved by the module system and composes no path.
    expect(
      reachesRendererSource('import { x } from "../../src/renderer/src/console/core.js";', "p.ts"),
    ).toBe(false);
    // A literal is a path where it is USED as one: the specifier is resolved by the
    // module system, the initializer names a path, and the assertion argument — the
    // form that reported `vitest-project-globs.test.ts` as an offender — is neither.
    expect(pathLiteralsIn('import { x } from "./a.js";', "p.ts")).toStrictEqual([]);
    expect(pathLiteralsIn('const b = "./a.js";', "p.ts")).toStrictEqual(["./a.js"]);
    expect(pathLiteralsIn('expect(ownersOf("src/renderer/src/a.ts")).toEqual([]);', "p.ts")) //
      .toStrictEqual([]);
    expect(pathLiteralsIn('const at = join(root, "src/renderer/src");', "p.ts")) //
      .toStrictEqual(["src/renderer/src"]);
    // And the shared walk's own roots reach it without composing a segment at all.
    expect(
      reachesRendererSource(
        "const modules = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });",
        "p.ts",
      ),
    ).toBe(true);
    // The shared-walk import is read as an import, not as a mention.
    expect(importsSharedWalk('import { x } from "../console-source-modules.js";', "p.ts")).toBe(
      true,
    );
    expect(importsSharedWalk('const note = "../console-source-modules.js";', "p.ts")).toBe(false);
  });
});

describe("source-walk chokepoint — the walk answers what its options say", () => {
  it("excludes tests by default and admits them on request", () => {
    const production = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });
    const withTests = consoleSourceModules({ roots: [CONSOLE_DIRECTORY], tests: true });
    expect(production.length).toBeGreaterThan(20);
    expect(withTests.length).toBeGreaterThan(production.length);
    expect(production.map((module) => module.displayPath)).not.toContain(
      "console/bridge/fixture-bridge.test-support.ts",
    );
    expect(withTests.map((module) => module.displayPath)).toContain(
      "console/bridge/fixture-bridge.test-support.ts",
    );
    // The divergence that made the two hand-rolled walks disagree, asserted as one
    // answer: `.test-support.*` and `.test.*` are the same class to this walk, so no
    // caller can end up with one and not the other.
    expect(withTests.map((module) => module.displayPath)).toContain("console/core/instant.test.ts");
  });

  it("never admits a declaration file on either setting", () => {
    for (const tests of [false, true]) {
      expect(
        consoleSourceModules({ tests }).filter((module) => module.displayPath.endsWith(".d.ts")),
      ).toStrictEqual([]);
    }
  });

  it("serves stylesheets and modules as separate lists off one walk", () => {
    // The second file kind, and the reason it is a sibling rather than a flag: a
    // source-text tripwire handed a `.css` entry would parse it as TypeScript, and a
    // stylesheet gate handed a `.ts` one would read declarations as rules.
    const stylesheets = consoleStylesheets({ roots: [CONSOLE_DIRECTORY] });
    expect(stylesheets.length).toBeGreaterThan(0);
    expect(stylesheets.every((sheet) => sheet.displayPath.endsWith(".css"))).toBe(true);
    const modules = consoleSourceModules({ roots: [CONSOLE_DIRECTORY], tests: true });
    expect(modules.some((module) => module.displayPath.endsWith(".css"))).toBe(false);
    // Same roots, same sorting, same shape — which is the part a root rename moves
    // in one place.
    expect(
      [...stylesheets].sort((a, b) => a.displayPath.localeCompare(b.displayPath)),
    ).toStrictEqual([...stylesheets]);
  });

  it("defaults to both console roots, and a missing root contributes nothing", () => {
    expect(CONSOLE_SOURCE_ROOTS).toContain(CONSOLE_DIRECTORY);
    expect(consoleSourceModules().length).toBeGreaterThanOrEqual(
      consoleSourceModules({ roots: [CONSOLE_DIRECTORY] }).length,
    );
  });

  it("names the module a caller asked for, and says which name was not found", () => {
    const modules = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });
    expect(moduleNamed(modules, "console/core/instant.ts").displayPath).toBe(
      "console/core/instant.ts",
    );
    expect(readConsoleSourceModule(moduleNamed(modules, "console/core/instant.ts"))).toContain(
      "parseInstant",
    );
    expect(() => moduleNamed(modules, "console/core/absent.ts")).toThrow(
      "the scan did not reach console/core/absent.ts",
    );
    expect(() => moduleNamed(modules, "console/core/absent.ts", "the reader")).toThrow(
      "the scan did not reach the reader at console/core/absent.ts",
    );
  });
});

describe("the shared walk — answers files, never a directory with a file's name", () => {
  const screenshotTier = resolve(HERE, "..", "screenshot");

  it("control: the tier holds a DIRECTORY whose name is extension-shaped", () => {
    // Vitest names a screenshot tier's committed reference directory after its spec,
    // so this entry is what a walk deciding by extension would admit as a module.
    const entries = readdirSync(screenshotTier, { recursive: true, encoding: "utf8" }).map(
      (entry) => entry.split("\\").join("/"),
    );
    const directoryNamedLikeASpec = entries.find((entry) =>
      entry.endsWith("__screenshots__/frame.test.tsx"),
    );
    expect(directoryNamedLikeASpec).toBeDefined();
    expect(statSync(join(screenshotTier, directoryNamedLikeASpec ?? "")).isDirectory()).toBe(true);
  });

  it("returns only files from a root that holds such a directory", () => {
    const modules = consoleSourceModules({ roots: [screenshotTier], tests: true });
    expect(modules.length).toBeGreaterThan(0);
    const notFiles = modules.filter((module) => !statSync(module.absolutePath).isFile());
    expect(notFiles.map((module) => module.displayPath)).toStrictEqual([]);
    // The spec itself is still read; only its reference directory is not.
    expect(modules.some((module) => module.relativePath === "frame.test.tsx")).toBe(true);
  });

  it("control: the tier scan reads real bytes, not an empty file", () => {
    // `readFileSync` here is what makes this gate a member of the reader claim as
    // well as the walk claim, which is why it is admitted by name above.
    expect(readFileSync(join(HERE, "source-walk-census.ts"), "utf8")).toContain("walkOffenders");
  });
});
