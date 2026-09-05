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
// ANSWERED WITH THE COMPILER AND NOT WITH A PATTERN. The first cut of this gate read
// `/^import\s+"([^"]+\.css)";$/gm`, which is three false answers in one expression: an
// import written without its semicolon is legal ASI and was invisible, an import
// indented inside a block was invisible, and a `.css` path inside a comment or a string
// literal was an import. `test/console/typescript-source.ts` states the rule this file
// now keeps — a question about which bindings a module imports is answered by the
// parser, because a regular expression cannot see a declaration boundary — and the test
// for a side-effect import is the compiler's own: an `ImportDeclaration` with no
// `importClause` is the form that imports nothing and runs the module.
//
// AND THE SPECIFIER IS RESOLVED, NOT REDUCED TO A BASENAME. Comparing file names let
// any door import any family's sheet as long as the names matched, which is the exact
// mistake this gate exists to catch — `repos/index.ts` importing `agents/agents.css`
// would have read as `agents/index.ts` importing its own. Every specifier is resolved
// against the directory of the module that wrote it and compared as a console-relative
// path, so the sheet a door claims is the sheet on disk.
//
// WHAT COUNTS AS A FAMILY DOOR, and why the line is drawn there. A console family
// door is `console/<family>/index.ts` — one directory below the console root. A
// SUB-MODULE door (`repos/artifact-pane/index.ts`, `bridge/growth-values/index.ts`) is a
// barrel too, and it is exactly the case this test exists to catch: it publishes to
// its own family only and is reached by deep intra-family specifiers, so a sheet
// imported from one arrives on the paths that reach THAT barrel and on no other. The
// artifact pane shipped that way — `repos/artifact-pane/index.ts` imported
// `artifact.css` — which meant a surface composing the pane through the repos family
// door alone drew it unstyled, and it is the shape the negative controls below plant.
//
// The importer is checked, not the sheet's neighbours: a family's sheets may sit in
// its sub-module directories, and the repos family's seven do, so `repos/index.ts`
// legitimately imports `repos/diff-pane/diff.css` and `repos/artifact-pane/artifact.css`
// alongside its own. What it may never do is let a second module import one.

import { posix } from "node:path";

import { describe, expect, it } from "vitest";
import ts from "typescript";

import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  consoleStylesheets,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** The console root alone: the shell composes seats and ships no sheet of its own. */
const CONSOLE_ROOT_ONLY = { roots: [CONSOLE_DIRECTORY] } as const;

/**
 * Every stylesheet specifier a module imports for its side effect.
 *
 * A pure function over text rather than a loop inside a test, so the controls below
 * can drive it with source whose verdict is known and the checker is proved to bite
 * without perturbing a real module.
 *
 * `importClause === undefined` is the whole test for the side-effect form, and it is
 * the only form this bundler configuration admits for a sheet — a named import from a
 * `.css` file would be a CSS-modules edge, and this package configures none. The
 * specifier is read off `moduleSpecifier` as a string literal rather than off the
 * node's text, so a template or a computed specifier answers nothing instead of
 * answering the raw characters.
 */
function importedStylesheets(fileName: string, sourceText: string): readonly string[] {
  const parsed = parseSourceText(fileName, sourceText);
  const specifiers: string[] = [];
  forEachDescendant(parsed, (node) => {
    if (!ts.isImportDeclaration(node) || node.importClause !== undefined) {
      return;
    }
    if (!ts.isStringLiteral(node.moduleSpecifier)) {
      return;
    }
    if (node.moduleSpecifier.text.endsWith(".css")) {
      specifiers.push(node.moduleSpecifier.text);
    }
  });
  return specifiers;
}

/**
 * One imported specifier as a console-relative path.
 *
 * `posix.join` rather than the platform's, because the paths on both sides of the
 * comparison are console-relative and written with forward slashes: the walk
 * normalizes its own, and a specifier is a module specifier and never a file path.
 */
function resolveStylesheetSpecifier(moduleRelativePath: string, specifier: string): string {
  return posix.join(posix.dirname(moduleRelativePath), specifier);
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

/** Every module that imports a stylesheet, with the console-relative sheets it named. */
function stylesheetImporters(): readonly { module: string; sheets: readonly string[] }[] {
  return consoleSourceModules(CONSOLE_ROOT_ONLY)
    .map((module) => {
      const relativePath = module.relativePath.split("\\").join("/");
      return {
        module: relativePath,
        sheets: importedStylesheets(relativePath, readConsoleSourceModule(module)).map(
          (specifier) => resolveStylesheetSpecifier(relativePath, specifier),
        ),
      };
    })
    .filter((entry) => entry.sheets.length > 0);
}

describe("stylesheet edges — a sheet is imported from its family's door and nowhere else", () => {
  const importers = stylesheetImporters();

  it("accounts for every sheet in the tree, by path and not by name", () => {
    // Without this, a wrong CONSOLE_DIRECTORY or a specifier form the parser walk does
    // not reach would scan nothing and the assertion below would pass over the empty
    // set. Every `.css` file in the tree is accounted for by an importer, so a sheet
    // nobody imports is caught here rather than shipping unreferenced — and the
    // comparison is over console-relative paths, so two families' sheets sharing a
    // name cannot stand in for each other.
    const stylesheets = consoleStylesheets(CONSOLE_ROOT_ONLY)
      .map((sheet) => sheet.relativePath.split("\\").join("/"))
      .sort();
    expect(stylesheets.length).toBeGreaterThan(3);
    const imported = importers.flatMap((entry) => entry.sheets).sort();
    expect(imported).toStrictEqual(stylesheets);
  });

  it("no module but a family door imports one", () => {
    const offenders = importers
      .filter((entry) => !isFamilyDoor(entry.module))
      .map((entry) => `${entry.module}: ${entry.sheets.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: a sub-module door importing a sheet is caught", () => {
    // The exact shape `repos/artifact-pane/index.ts` shipped in, planted as text so the
    // control keeps biting after the real module is fixed. Both halves are asserted:
    // the module is not a door, and the sheet is seen at the path the door would give
    // it rather than at the name it was written under.
    const subModuleDoor = "repos/artifact-pane/index.ts";
    expect(isFamilyDoor(subModuleDoor)).toBe(false);
    expect(importedStylesheets(subModuleDoor, 'import "./artifact.css";\n')).toStrictEqual([
      "./artifact.css",
    ]);
    expect(resolveStylesheetSpecifier(subModuleDoor, "./artifact.css")).toBe(
      "repos/artifact-pane/artifact.css",
    );
  });

  it("negative control: a component importing a sheet is caught, and a door is not", () => {
    // The other way in — a sheet imported from the component that needs it, which is
    // how a family ends up with its styling split across import paths. And the
    // legitimate case beside it, including a door reaching into a sub-module
    // directory for a sheet, which the repos family door does seven times.
    expect(isFamilyDoor("repos/mounts/RepoSection.tsx")).toBe(false);
    expect(isFamilyDoor("repos/index.ts")).toBe(true);
    expect(
      importedStylesheets("frame/Frame.tsx", 'import "../repos/artifact-pane/artifact.css";\n'),
    ).toStrictEqual(["../repos/artifact-pane/artifact.css"]);
    expect(
      importedStylesheets("repos/index.ts", 'import { ArtifactPane } from "./ArtifactPane.js";\n'),
    ).toStrictEqual([]);
  });

  it("negative control: the two forms the pattern this replaced could not see", () => {
    // Both are legal TypeScript and both were invisible to `/^import\s+"…";$/gm`: an
    // import whose statement is terminated by ASI rather than by a semicolon, and an
    // import that is not at column zero. A gate that cannot see an import cannot rule
    // on it, and neither form is rare enough to call unreachable.
    expect(importedStylesheets("repos/index.ts", 'import "./repos.css"\n')).toStrictEqual([
      "./repos.css",
    ]);
    expect(importedStylesheets("repos/index.ts", '  import "./repos.css";\n')).toStrictEqual([
      "./repos.css",
    ]);
  });

  it("negative control: a `.css` path that is not an import is not one", () => {
    // The third false answer the pattern gave, in the two shapes it gave it: a path in
    // a comment and a path in a string. A gate that counted either would report a
    // module as a stylesheet importer for mentioning a sheet's name.
    expect(
      importedStylesheets("repos/index.ts", '// import "./repos.css";\nexport {};\n'),
    ).toStrictEqual([]);
    expect(
      importedStylesheets("repos/index.ts", 'export const sheet = "./repos.css";\n'),
    ).toStrictEqual([]);
    expect(
      importedStylesheets("repos/index.ts", 'import { thing } from "./repos.css";\n'),
    ).toStrictEqual([]);
  });

  it("negative control: two families' sheets sharing a name resolve apart", () => {
    // What the basename comparison this replaced could not distinguish. Under names
    // alone, a door importing another family's sheet matched the sheet it should have
    // imported and the offence read as compliance.
    expect(resolveStylesheetSpecifier("repos/index.ts", "./sheet.css")).toBe("repos/sheet.css");
    expect(resolveStylesheetSpecifier("agents/index.ts", "./sheet.css")).toBe("agents/sheet.css");
    expect(resolveStylesheetSpecifier("repos/index.ts", "../agents/sheet.css")).toBe(
      "agents/sheet.css",
    );
  });
});
