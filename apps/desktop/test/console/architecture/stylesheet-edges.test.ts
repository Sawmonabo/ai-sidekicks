// Every console stylesheet enters through its own family's door, and through one.
//
// `apps/desktop/AGENTS.md` §Module shape states it in one line — "A family's CSS is
// imported from that family's barrel and from nowhere else" — and until this file
// nothing checked it. The rule looked self-enforcing while each family had exactly
// one sheet named after itself; it stops being self-enforcing the moment a family
// splits its sheet by surface, because then there are five files any component in
// the family could reach for and four of them would still look plausible in a diff.
//
// WHAT BREAKS IF IT IS NOT HELD. A stylesheet imported from a component is an edge
// the bundler follows per importing module, so one shape's CSS arrives in whichever
// chunk happened to reach it first — and the terminal family's sheet, which
// `Spec-023 §Console Design (Meridian)` §Budgets deliberately keeps OUT of the
// initial bundle, would land in it the day a statically reached module imported it.
// The single edge at the door is also what makes "no surface can render a shape
// whose CSS never arrived" true: the door is on every path into the family.
//
// WHAT THIS DOES NOT CLAIM. Nothing here is about what the CSS says. The token
// resolution is `test/console/assets/generated-tokens.test.ts`'s and the computed
// geometry is the browser tier's; this file owns the import graph alone.
//
// A LIBRARY'S OWN SHEET IS NOT A FAMILY'S SHEET, so only RELATIVE specifiers are
// read. `terminal/xterm-adapter.ts` imports `@xterm/xterm/css/xterm.css` from the
// lazy chunk's entry deliberately, and that placement is the point: the emulator's
// grid geometry has to arrive on the same edge as the code that draws the grid, and
// hoisting it to the family door would put it in the document the operator waits
// for. The rule this file holds is about which door a family's OWN sheet enters by.

import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  consoleSourceModules,
  readConsoleSourceModule,
  moduleNamed,
  CONSOLE_DIRECTORY,
} from "../console-source-modules.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The one member of Vite's `import.meta` this tier reads, declared where it is read.
 *
 * The architecture tier is a Node program and its `tsconfig` deliberately does not
 * pull in `vite/client` wholesale — the renderer's own `console-env.d.ts` says why
 * for its half — so the member is named structurally at the one call site rather than
 * by widening a config for every gate in the directory. Vitest transforms this file
 * with Vite, so the call itself is resolved at build time exactly as it is in the
 * renderer.
 */
interface ViteGlobImportMeta {
  readonly glob: (
    pattern: string,
    options?: { readonly query?: string },
  ) => Readonly<Record<string, unknown>>;
}

/**
 * Every console source module, through the tier's ONE walk.
 *
 * `source-walk-chokepoint.test.ts` fails a gate that reaches renderer source through
 * a `readdirSync` of its own: five private walks are five slightly different ideas of
 * what counts as source, and the difference between them is invisible until one of
 * them scans a file the others do not — which is how this file came to exclude
 * `.test.` by substring while its neighbours excluded four exact suffixes.
 */
const CONSOLE_MODULES = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });

/**
 * Every stylesheet under the console, console-relative.
 *
 * Through Vite's own module graph rather than through a directory read, because the
 * walk above answers for TypeScript and this claim needs the other half — and a
 * second directory read here is the exact shape the chokepoint forbids. The glob is
 * resolved by the same bundler that resolves the imports these edges are about, so
 * both halves of every assertion below come from one resolver.
 */
const STYLESHEET_PATHS: readonly string[] = Object.keys(
  (import.meta as ImportMeta & ViteGlobImportMeta).glob(
    "../../../src/renderer/src/console/**/*.css",
    { query: "?url" },
  ),
)
  .map((specifier) => consoleRelative(resolve(HERE, specifier)))
  .sort();

/** The one file in a family that may carry a stylesheet import. */
const FAMILY_DOOR = "index.ts";

/** An `import "./somewhere.css";` statement, however it is quoted. Relative only. */
const STYLESHEET_IMPORT_PATTERN = /import\s+["'](\.[^"']*\.css)["']/gu;

/** A path under the console, spelled the way every message here names one. */
function consoleRelative(absolutePath: string): string {
  return relative(CONSOLE_DIRECTORY, absolutePath).split("\\").join("/");
}

/** The family a console-relative path belongs to — its first path segment. */
function familyOf(consoleRelativePath: string): string {
  return consoleRelativePath.split("/")[0] ?? "";
}

/** Every stylesheet a module imports, as console-relative paths. */
function stylesheetImportsOf(consoleRelativePath: string): readonly string[] {
  const source = readConsoleSourceModule(
    moduleNamed(CONSOLE_MODULES, `console/${consoleRelativePath}`),
  );
  const importedFrom = dirname(consoleRelativePath);
  return [...source.matchAll(STYLESHEET_IMPORT_PATTERN)].map((match) =>
    consoleRelative(resolve(CONSOLE_DIRECTORY, importedFrom, match[1] ?? "")),
  );
}

describe("stylesheet edges — a family's CSS enters at that family's door", () => {
  const stylesheets = STYLESHEET_PATHS;
  const modules = CONSOLE_MODULES.map((module) => module.displayPath.slice("console/".length));

  it("finds the console's stylesheets and modules at all", () => {
    // Without this, a wrong root would scan nothing and every assertion below would
    // pass over the empty set.
    expect(stylesheets.length).toBeGreaterThan(4);
    expect(modules.length).toBeGreaterThan(100);
  });

  it("is imported by no module but a family door", () => {
    const offenders = modules
      .filter((module) => !module.endsWith(`/${FAMILY_DOOR}`) && module !== FAMILY_DOOR)
      .flatMap((module) => stylesheetImportsOf(module).map((sheet) => `${module} -> ${sheet}`));
    expect(offenders).toStrictEqual([]);
  });

  it("is imported by its OWN family's door and no other", () => {
    // A submodule reaching for a sibling family's sheet is the same defect one level
    // out: the sheet then arrives on whichever chunk that family lands in.
    const crossFamilyEdges = modules
      .filter((module) => module.endsWith(`/${FAMILY_DOOR}`))
      .flatMap((door) =>
        stylesheetImportsOf(door)
          .filter((sheet) => familyOf(sheet) !== familyOf(door))
          .map((sheet) => `${door} -> ${sheet}`),
      );
    expect(crossFamilyEdges).toStrictEqual([]);
  });

  it("is reached by exactly one import, and every sheet is reached", () => {
    // Two edges into one sheet is two chunks that may both carry it; zero is a shape
    // that renders unstyled, which in this console is a pane with no geometry at all.
    const edgeCountBySheet = new Map(stylesheets.map((sheet) => [sheet, 0]));
    for (const module of modules) {
      for (const sheet of stylesheetImportsOf(module)) {
        edgeCountBySheet.set(sheet, (edgeCountBySheet.get(sheet) ?? 0) + 1);
      }
    }
    const wrongEdgeCounts = [...edgeCountBySheet]
      .filter(([, count]) => count !== 1)
      .map(([sheet, count]) => `${sheet}: ${String(count)}`);
    expect(wrongEdgeCounts).toStrictEqual([]);
  });

  it("negative control: the checker reads a submodule's import and a door's", () => {
    // The clean results above mean nothing unless the reader recognises the two
    // shapes it is looking for. Read out of the real tree rather than asserted about
    // it: the browser family's door carries its five sheets, and the component beside
    // it carries none.
    const doorEdges = stylesheetImportsOf(`browser/${FAMILY_DOOR}`);
    expect(doorEdges.length).toBeGreaterThan(1);
    expect(doorEdges.every((sheet) => familyOf(sheet) === "browser")).toBe(true);
    expect(stylesheetImportsOf("browser/BudgetMeter.tsx")).toStrictEqual([]);
  });
});
