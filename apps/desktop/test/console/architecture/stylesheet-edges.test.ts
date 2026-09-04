// Where a stylesheet may be imported from, asserted.
//
// `apps/desktop/AGENTS.md` §Module shape carries the rule in one line — "A family's
// CSS is imported from that family's barrel and from nowhere else" — and until this
// file nothing checked it. Neither mechanical gate can: knip answers reachability
// from an entry point, and a sheet imported from the wrong module is perfectly
// reachable; dependency-cruiser answers which import is ALLOWED, but its resolver
// runs on the extension list this package configures, which does not carry `.css`,
// so a stylesheet specifier is not a graph edge it can rule on. The claim is a
// property of one line of source text, which is the architecture tier's own subject.
//
// WHAT COUNTS AS A FAMILY DOOR, and why the line is drawn there. A console family
// door is `console/<family>/index.ts` — one directory below the console root. A
// SUB-MODULE door (`panes/artifact/index.ts`, `bridge/growth-values/index.ts`) is a
// barrel too, and it is exactly the case this test exists to catch: it publishes to
// its own family only and is reached by deep intra-family specifiers, so a sheet
// imported from one arrives on the paths that reach THAT barrel and on no other. The
// artifact pane shipped that way — `panes/artifact/index.ts` imported
// `artifact.css` — which meant a surface composing the pane through the repos family
// door alone drew it unstyled, and it is the shape the negative controls below plant.
//
// The importer is checked, not the sheet's neighbours: a family may occupy more than
// one directory, and the repos family occupies three, so `repos/index.ts`
// legitimately imports `panes/diff/diff.css` and `panes/artifact/artifact.css`
// alongside its own. What it may never do is let a second module import one.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIRECTORY = resolve(HERE, "..", "..", "..", "src", "renderer", "src", "console");

/**
 * Every stylesheet specifier a module imports for its side effect.
 *
 * A pure function over text rather than a loop inside a test, so the controls below
 * can drive it with source whose verdict is known and the checker is proved to bite
 * without perturbing a real module. Side-effect form only, which is the only form
 * this bundler configuration admits for a sheet — a named import from a `.css` file
 * would be a CSS-modules edge, and this package configures none.
 */
function importedStylesheets(source: string): readonly string[] {
  return [...source.matchAll(/^import\s+"([^"]+\.css)";$/gm)].map((match) => match[1] ?? "");
}

/**
 * Whether a console module is its family's DOOR.
 *
 * One directory below the console root and named `index.ts`. A deeper `index.ts` is
 * a sub-module door and answers false, which is the whole claim: the two barrel
 * kinds are told apart by depth, because that is what tells them apart.
 */
function isFamilyDoor(moduleRelativePath: string): boolean {
  const segments = moduleRelativePath.split("/");
  return segments.length === 2 && segments[1] === "index.ts";
}

function consoleSourceModules(): readonly string[] {
  return readdirSync(CONSOLE_DIRECTORY, { recursive: true, encoding: "utf8" })
    .filter(
      (entry) =>
        (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
        !entry.endsWith(".test.ts") &&
        !entry.endsWith(".test.tsx") &&
        !entry.endsWith(".d.ts"),
    )
    .map((entry) => entry.split("\\").join("/"))
    .sort();
}

/** Every module that imports a stylesheet, with what it imported. */
function stylesheetImporters(): readonly { module: string; sheets: readonly string[] }[] {
  return consoleSourceModules()
    .map((module) => ({
      module,
      sheets: importedStylesheets(readFileSync(join(CONSOLE_DIRECTORY, module), "utf8")),
    }))
    .filter((entry) => entry.sheets.length > 0);
}

describe("stylesheet edges — a sheet is imported from its family's door and nowhere else", () => {
  const importers = stylesheetImporters();

  it("finds the console's stylesheet importers at all", () => {
    // Without this, a wrong CONSOLE_DIRECTORY or a specifier form the pattern does
    // not match would scan nothing and the assertion below would pass over the
    // empty set. Every `.css` file in the tree is accounted for by an importer, so
    // a sheet nobody imports is caught here rather than shipping unreferenced.
    const stylesheets = readdirSync(CONSOLE_DIRECTORY, { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith(".css"))
      .map((entry) => entry.split("\\").join("/").split("/").at(-1) ?? "")
      .sort();
    expect(stylesheets.length).toBeGreaterThan(3);
    const imported = importers
      .flatMap((entry) => entry.sheets.map((sheet) => sheet.split("/").at(-1) ?? ""))
      .sort();
    expect(imported).toStrictEqual(stylesheets);
  });

  it("no module but a family door imports one", () => {
    const offenders = importers
      .filter((entry) => !isFamilyDoor(entry.module))
      .map((entry) => `${entry.module}: ${entry.sheets.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: a sub-module door importing a sheet is caught", () => {
    // The exact shape `panes/artifact/index.ts` shipped in, planted as text so the
    // control keeps biting after the real module is fixed. Both halves are asserted:
    // the module is not a door, and the sheet is seen.
    const subModuleDoor = "panes/artifact/index.ts";
    expect(isFamilyDoor(subModuleDoor)).toBe(false);
    expect(importedStylesheets('import "./artifact.css";\n')).toStrictEqual(["./artifact.css"]);
  });

  it("negative control: a component importing a sheet is caught, and a door is not", () => {
    // The other way in — a sheet imported from the component that needs it, which is
    // how a family ends up with its styling split across import paths. And the
    // legitimate case beside it, including a door reaching into a sub-module
    // directory for a sheet, which the repos family door does three times.
    expect(isFamilyDoor("repos/RepoSection.tsx")).toBe(false);
    expect(isFamilyDoor("repos/index.ts")).toBe(true);
    expect(importedStylesheets('import "../panes/artifact/artifact.css";\n')).toStrictEqual([
      "../panes/artifact/artifact.css",
    ]);
    expect(
      importedStylesheets('import { ArtifactPane } from "./ArtifactPane.js";\n'),
    ).toStrictEqual([]);
  });
});
