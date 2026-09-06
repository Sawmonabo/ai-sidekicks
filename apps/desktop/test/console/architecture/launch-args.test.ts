// The command line the two launching tiers actually get.
//
// Two claims, and neither is the other's approximation. The COMPOSITION claim is
// about the array: a GPU-less host is handed a software GL stack and a host with
// its own is not, which is a property no launch has to run to check. The HOME
// claim is about where switches are spelled: the module that calls
// `_electron.launch` spells none of its own, so a switch cannot be added at the
// launch and skip the composition this file reads.
//
// The second claim exists because the first one alone has been true before and
// bought nothing. `composeLaunchArgs` and its whole refusal machinery landed once
// with a passing test and NO caller, and were deleted for it two commits later
// (`test(desktop): delete the launch-args composer that has no reader`), while the
// tier that motivated them went on launching with a hard-coded pair. A composer
// whose correctness is asserted and whose use is assumed is the exact shape that
// left the `terminal-instance-memory` row unreadable on every Linux runner.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
  type ConsoleSourceModule,
} from "../console-source-modules.js";
import {
  composeLaunchArgs,
  SOFTWARE_GRAPHICS_SWITCHES,
  softwareGraphicsSwitchesFor,
  type LaunchPlatform,
} from "../launch-args.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST_TIER_DIRECTORY = resolve(HERE, "..");

/** The module that owns the launch, named by the display path the scan reports. */
const LAUNCHER_DISPLAY_PATH = "test/console/electron-harness.ts";

/** The package the launcher binds Electron through. */
const PLAYWRIGHT_SPECIFIER = "@playwright/test";
const ELECTRON_LAUNCH_BINDING = "_electron";

/** The composer, the input that decides its whole software-GL arm, and the only
 * expression that may fill it. */
const COMPOSER_FUNCTION_NAME = "composeLaunchArgs";
const PLATFORM_PROPERTY_NAME = "platform";
const HOST_PLATFORM_EXPRESSION = "process.platform";

/** Stand-ins for the two arguments the harness owns, so a failure names the shape. */
const PROFILE_DIRECTORY = "/tmp/ai-sidekicks-console-probe";
const MAIN_ENTRY_PATH = "/repo/apps/desktop/out/main/index.js";

/** The composed argv for one platform, with everything else held still. */
function argsFor(platform: LaunchPlatform, isPreciseHeapReadingRequired = false): string[] {
  return composeLaunchArgs({
    profileDirectory: PROFILE_DIRECTORY,
    mainEntryPath: MAIN_ENTRY_PATH,
    isPreciseHeapReadingRequired,
    platform,
  });
}

/** Every module in the console's test tier, harnesses and models included. */
function testTierModules(): readonly ConsoleSourceModule[] {
  return consoleSourceModules({ roots: [TEST_TIER_DIRECTORY], tests: true });
}

/**
 * Whether `source` imports the binding a launch is started through.
 *
 * The import is the subject rather than the call, because it is what makes a
 * launch REACHABLE from a module: a second launcher would have to import this to
 * exist, and would then be free to compose its own arguments where nothing reads
 * them.
 */
function importsTheElectronLauncher(source: string, fileName: string): boolean {
  for (const statement of parseSourceText(fileName, source).statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (statement.moduleSpecifier.text !== PLAYWRIGHT_SPECIFIER) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) {
      continue;
    }
    if (
      bindings.elements.some(
        (element) => (element.propertyName ?? element.name).text === ELECTRON_LAUNCH_BINDING,
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Every string a module could pass as a switch, in the argv sense.
 *
 * A switch reaches Chromium as its own argv element, so what is read is a literal
 * that STARTS with `-`: a whole string, or the head of a template whose
 * substitutions fill in a value. Read by parse rather than by regex on this tier's
 * standing rule — a `--user-data-dir` inside a comment or a doc block is prose,
 * and a grep cannot tell it from an argument.
 */
function switchLiteralsIn(source: string, fileName: string): readonly string[] {
  const found: string[] = [];
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    const text =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node)
        ? node.text
        : undefined;
    if (text !== undefined && text.startsWith("-")) {
      found.push(text);
    }
  });
  return found;
}

/**
 * The text of every `platform:` the module hands `composeLaunchArgs`.
 *
 * The composition claim above is about a FUNCTION, and a function is only as right
 * as what it is called with: `softwareGraphicsSwitchesFor` decides the whole
 * software-GL arm off this one property, so a call site that wrote a platform down
 * would compose an empty switch set on every Linux launch while every case above
 * stayed green. Nothing else in the file reaches that property — `switchLiteralsIn`
 * collects literals starting with `-`, and `"darwin"` is not one — which is how the
 * defect this reads for is invisible to the home claim beside it.
 *
 * The initializer's own text rather than a shape test, because the two failures worth
 * separating are "a literal" and "some other expression": the first names the wrong
 * host, the second may be a helper that resolves one, and a reviewer reading the
 * failure needs to see which arrived.
 */
function composerPlatformInitializersIn(source: string, fileName: string): readonly string[] {
  const parsed = parseSourceText(fileName, source);
  const found: string[] = [];
  forEachDescendant(parsed, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
      return;
    }
    if (node.expression.text !== COMPOSER_FUNCTION_NAME) {
      return;
    }
    for (const argument of node.arguments) {
      if (!ts.isObjectLiteralExpression(argument)) {
        continue;
      }
      for (const property of argument.properties) {
        if (!ts.isPropertyAssignment(property)) {
          continue;
        }
        const propertyName = ts.isIdentifier(property.name)
          ? property.name.text
          : ts.isStringLiteral(property.name)
            ? property.name.text
            : undefined;
        if (propertyName === PLATFORM_PROPERTY_NAME) {
          found.push(
            parsed.text.slice(property.initializer.getStart(parsed), property.initializer.end),
          );
        }
      }
    }
  });
  return found;
}

describe("launch arguments — the software GL a GPU-less host is given", () => {
  it("hands a Linux launch the whole software graphics stack, in order", () => {
    // The pre-fix shape passed nothing here, so the ubuntu runner reached the
    // `terminal-instance-memory` row with no WebGL2 and the pane fell back to the
    // DOM renderer — a subject the row does not bound.
    expect(argsFor("linux")).toStrictEqual([
      `--user-data-dir=${PROFILE_DIRECTORY}`,
      ...SOFTWARE_GRAPHICS_SWITCHES,
      MAIN_ENTRY_PATH,
    ]);
  });

  it("names the three switches SwANGLE needs and no others", () => {
    // Pinned as a set rather than left to the composition case: two of them select
    // the driver and the third is the opt-in that lets WebGL be served from it, and
    // a launch missing any one of the three reaches a renderer with no WebGL2.
    expect([...SOFTWARE_GRAPHICS_SWITCHES]).toStrictEqual([
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ]);
  });

  it("gives a host that has its own GL none of them", () => {
    // The negative control, and it is not tidiness. Measured on this Electron's
    // darwin-arm64 build: with these switches the GPU process dies with
    // `eglInitialize SwANGLE failed` and the renderer reports no WebGL2 at all,
    // where the unswitched launch reports the ANGLE Metal renderer. Forcing them
    // everywhere would take the context away on exactly the platform that has one.
    for (const platform of ["darwin", "win32"] as const) {
      expect(argsFor(platform)).toStrictEqual([
        `--user-data-dir=${PROFILE_DIRECTORY}`,
        MAIN_ENTRY_PATH,
      ]);
      expect(softwareGraphicsSwitchesFor(platform)).toStrictEqual([]);
    }
  });

  it("keeps the profile first and the entry path last on every platform", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const args = argsFor(platform, true);
      expect(args.at(0)).toBe(`--user-data-dir=${PROFILE_DIRECTORY}`);
      expect(args.at(-1)).toBe(MAIN_ENTRY_PATH);
    }
  });

  it("adds the precise-heap switch only for a launch that measures a heap", () => {
    expect(argsFor("linux", true)).toContain("--enable-precise-memory-info");
    expect(argsFor("linux", false)).not.toContain("--enable-precise-memory-info");
  });

  it("cannot leak one launch's arguments into the next", () => {
    const first = argsFor("linux");
    first.push("--a-switch-a-caller-appended");
    expect(argsFor("linux")).not.toContain("--a-switch-a-caller-appended");
  });
});

describe("launch arguments — one home for every switch a launch passes", () => {
  const modules = testTierModules();

  it("finds exactly one module that can start an Electron", () => {
    // Vacuity guard AND census in one: a scan that reached nothing would make the
    // claim below true over an empty set, and a second launcher would be free to
    // compose arguments this file never reads.
    const launchers = modules
      .filter((module) =>
        importsTheElectronLauncher(readConsoleSourceModule(module), module.displayPath),
      )
      .map((module) => module.displayPath);
    expect(launchers).toStrictEqual([LAUNCHER_DISPLAY_PATH]);
  });

  it("spells no switch of its own in the module that launches", () => {
    // Fails on the pre-fix launcher, which carried both
    // `"--enable-precise-memory-info"` and a `--user-data-dir=` template head
    // inline in its `args` array.
    const launcher = moduleNamed(modules, LAUNCHER_DISPLAY_PATH, "the shared Electron launcher");
    expect(switchLiteralsIn(readConsoleSourceModule(launcher), launcher.displayPath)).toStrictEqual(
      [],
    );
  });

  it("feeds the composer the host it launches on rather than a platform written down", () => {
    // The half the two claims above cannot make between them. The composition case
    // proves `composeLaunchArgs("linux")` yields the stack, and the home case proves
    // the launcher spells no switch of its own — and `platform: "darwin"` at the call
    // site satisfies both while composing an empty switch set on every Linux launch,
    // which is exactly the state that left the `terminal-instance-memory` row reading
    // a DOM-rendered pane on the runner it is measured on.
    const launcher = moduleNamed(modules, LAUNCHER_DISPLAY_PATH, "the shared Electron launcher");
    expect(
      composerPlatformInitializersIn(readConsoleSourceModule(launcher), launcher.displayPath),
    ).toStrictEqual([HOST_PLATFORM_EXPRESSION]);
  });

  it("proves that needle against a launcher that writes its platform down", () => {
    // The other half, and it is what makes the clean result above mean anything: a
    // walk that found no call at all would answer `[]`, which no assertion written
    // as "must be `process.platform`" could tell from a launcher that is correct.
    expect(
      composerPlatformInitializersIn(
        [
          "const args = composeLaunchArgs({",
          "  profileDirectory: profile.directory,",
          "  mainEntryPath: MAIN_ENTRY_PATH,",
          "  isPreciseHeapReadingRequired: false,",
          '  platform: "darwin",',
          "});",
        ].join("\n"),
        "planted-launcher.ts",
      ),
    ).toStrictEqual(['"darwin"']);
  });

  it("proves the needle by driving it against a launcher that does", () => {
    // Without this the clean result above would also be what a broken parse
    // produced. Both spellings the pre-fix launcher used are planted.
    expect(
      switchLiteralsIn(
        [
          'const flag = "--enable-precise-memory-info";',
          "const profile = `--user-data-dir=${directory}`;",
          "// a --use-gl in a comment is prose and is not an argument",
          'const notASwitch = "the launch is bounded";',
        ].join("\n"),
        "planted-launcher.ts",
      ),
    ).toStrictEqual(["--enable-precise-memory-info", "--user-data-dir="]);
  });
});
