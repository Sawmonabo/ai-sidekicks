// What a console test module does with the file system, read through the parser.
//
// The model beside `source-walk-chokepoint.test.ts`, split out for the reason the
// tier splits every census out: the gate states the claims, this states how a
// module is read, and the reading is what has to be exercised against planted text
// rather than against whichever module happens to do the thing today.
//
// EVERY PREDICATE HERE IS PARSER-EXACT, and that is the whole of their strength.
// The forms these replaced were text needles, and a text needle over source has one
// failure mode in both directions: it fires on a comment that names the thing, and
// it misses a spelling that does not carry the text. Both were live here — a header
// explaining why a gate does NOT walk names `readdirSync` in prose, and
// `import { readdirSync as listEntries }` carries no `readdirSync(` anywhere.
//
// A PATH IS A LITERAL IN A PATH POSITION, not any literal that looks like one, and
// both halves of that were measured rather than assumed. `import … from
// "../../../src/renderer/src/console/core/fixture-globals.js"` imports a VALUE: the
// module system resolves it, no directory is enumerated, and a scan reading
// specifiers as composed paths reported `budget/release-absence.test.ts` — which
// imports a renderer constant and then walks the BUILD OUTPUT — as an offender it
// could never satisfy. `vitest-project-globs.test.ts` is the other half: it hands
// `ownersOf()` the literal `"src/renderer/src/console/…/thing.test.tsx"` to ask which
// project glob claims that NAME, reads no such file, and a scan reading every literal
// reported it too. So a path literal is one handed to a path builder, a file-system
// binding, or a variable that names a path — and what remains is composition: the
// segments a module joins itself.

import ts from "typescript";

import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/**
 * The `node:fs` bindings that enumerate a directory.
 *
 * Read from the IMPORT rather than from call text: a binding has to be imported
 * before it can be aliased, so the import list sees `readdirSync as listEntries`
 * and `const walkDirectory = readdirSync` alike.
 *
 * `globSync` is in the list because it was live in this tier when the list was
 * written, not as a hypothetical: `browser-mode-optimize-deps.test.ts` walked the
 * whole of `src/` with it, with its own idea of what counts as source and no
 * exclusion for declaration files.
 */
export const DIRECTORY_WALK_BINDINGS: readonly string[] = [
  "readdirSync",
  "readdir",
  "globSync",
  "glob",
  "opendirSync",
  "opendir",
];

/** The `node:fs` bindings that read one file's bytes. */
export const FILE_READ_BINDINGS: readonly string[] = ["readFileSync", "readFile"];

/** The module specifiers either family is imported from. */
const FILE_SYSTEM_SPECIFIERS: readonly string[] = [
  "node:fs",
  "fs",
  "node:fs/promises",
  "fs/promises",
];

/** How a module shows it drew its set from the shared walk instead. */
const SHARED_WALK_SPECIFIER = "console-source-modules.js";

/**
 * The path segments a module composes to reach renderer source.
 *
 * This is what scopes both claims, and it replaces two hand-written admission lists.
 * A tier gate that enumerates test files to check a project glob, reads the CI
 * workflow, or reads a harness beside it holds no opinion about what counts as
 * console source and is outside both claims — while a module that reaches the
 * renderer tree has to reach it through the one walk.
 */
const RENDERER_REACH_SEGMENTS: readonly string[] = ["renderer", "src"];

/** The shared walk's exported roots, which reach the same tree without a segment. */
const SHARED_WALK_ROOTS: readonly string[] = [
  "CONSOLE_DIRECTORY",
  "SHELL_DIRECTORY",
  "CONSOLE_SOURCE_ROOTS",
];

/** One console test module, as both claims below read it. */
export interface TestTierModuleText {
  /** The path inside `test/console/`, which is what a failure message names. */
  readonly relativePath: string;
  readonly source: string;
}

/** Every `node:fs` binding out of `family` that `source` imports, or `[]`. */
function fileSystemImports(
  source: string,
  fileName: string,
  family: readonly string[],
): readonly string[] {
  const found: string[] = [];
  for (const statement of parseSourceText(fileName, source).statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (!FILE_SYSTEM_SPECIFIERS.includes(statement.moduleSpecifier.text)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) {
      continue;
    }
    // A NAMESPACE import is reported as its own finding rather than resolved
    // through: `import * as fs` puts every binding in the module's reach under a
    // name this scan cannot enumerate, and no module in this tier needs one.
    if (ts.isNamespaceImport(bindings)) {
      found.push(`* as ${bindings.name.text}`);
      continue;
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (family.includes(imported)) {
        found.push(imported);
      }
    }
  }
  return found;
}

/** Every directory-walking binding `source` imports from the file system, or `[]`. */
export function directoryWalkImports(source: string, fileName: string): readonly string[] {
  return fileSystemImports(source, fileName, DIRECTORY_WALK_BINDINGS);
}

/** Whether `source` reads a file's bytes itself, rather than through the walk. */
export function readsAFile(source: string, fileName: string): boolean {
  return fileSystemImports(source, fileName, FILE_READ_BINDINGS).length > 0;
}

/** Whether `source` imports the shared walk. */
export function importsSharedWalk(source: string, fileName: string): boolean {
  return moduleSpecifiersIn(source, fileName).some((specifier) =>
    specifier.endsWith(SHARED_WALK_SPECIFIER),
  );
}

/**
 * Every module specifier `source` names, static and dynamic alike.
 *
 * Exported for `source-parse-home.test.ts`, which asks the same question of a
 * different set — the difference between the two gates is which modules they hold to
 * which rule, never how a reach is read out of a module. This reader answers over
 * every import and export form, DEFAULT imports included, which is why the barrel
 * census's own `readModuleSyntax` is the wrong instrument there: that one reads named
 * bindings because a door republishes names, and `import ts from "typescript"` names
 * none.
 */
export function moduleSpecifiersIn(source: string, fileName: string): readonly string[] {
  const specifiers: string[] = [];
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
  });
  return specifiers;
}

/**
 * The callees whose string arguments are paths.
 *
 * The `node:path` builders and `URL`, plus every file-system binding, because a
 * literal handed straight to `readdirSync` or `globSync` is a path even though no
 * builder composed it.
 */
const PATH_COMPOSITION_CALLEES: readonly string[] = [
  "resolve",
  "join",
  "relative",
  "normalize",
  "URL",
  "pathToFileURL",
  "fileURLToPath",
  ...DIRECTORY_WALK_BINDINGS,
  ...FILE_READ_BINDINGS,
];

/**
 * Every string literal `source` uses as a path: an argument to a path builder or a
 * file-system binding, or the initializer of a variable that then carries one.
 *
 * Module specifiers are excluded, and a literal in any other position — an argument
 * to an assertion, a message, a glob pattern asked about by name — is not a path.
 */
export function pathLiteralsIn(source: string, fileName: string): readonly string[] {
  const literals: string[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      literals.push(node.text);
    }
  };
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      collect(node.initializer);
      return;
    }
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) {
      return;
    }
    const callee = node.expression;
    if (!ts.isIdentifier(callee) || !PATH_COMPOSITION_CALLEES.includes(callee.text)) {
      return;
    }
    for (const argument of node.arguments ?? []) {
      collect(argument);
    }
  });
  return literals;
}

/** Every identifier name `source` uses. */
function identifierNamesIn(source: string, fileName: string): readonly string[] {
  const names: string[] = [];
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (ts.isIdentifier(node)) {
      names.push(node.text);
    }
  });
  return names;
}

/**
 * Whether `source` composes a path into the renderer source tree.
 *
 * THREE FORMS, because the tree is reached three ways and a scan that knew only the
 * first reported clean on the other two. `resolve(HERE, "..", "renderer", "src")`
 * composes segment by segment; `new URL("../../../src/renderer/src/console", …)`
 * composes the whole path in ONE literal, which is how `assets/generated-tokens`
 * walked the console with nothing reporting it; and a module can take
 * `CONSOLE_DIRECTORY` from the shared module and then walk it itself, which carries
 * no path literal at all.
 *
 * The one-literal form requires the segments ADJACENT — `renderer` then `src` —
 * rather than merely present, because `out/renderer` is the build output and the
 * module that reads it is not making a claim about console source.
 */
export function reachesRendererSource(source: string, fileName: string): boolean {
  const literals = pathLiteralsIn(source, fileName);
  if (RENDERER_REACH_SEGMENTS.some((segment) => literals.includes(segment))) {
    return true;
  }
  if (literals.some(carriesAdjacentRendererSegments)) {
    return true;
  }
  const identifiers = identifierNamesIn(source, fileName);
  return SHARED_WALK_ROOTS.some((root) => identifiers.includes(root));
}

function carriesAdjacentRendererSegments(literal: string): boolean {
  const segments = literal.split("/");
  return segments.some((segment, index) => segment === "renderer" && segments[index + 1] === "src");
}

/**
 * The modules that reach renderer source and walk a directory of their own.
 *
 * Pure over the text it is handed, so the gate can hand it a PLANTED module and see
 * the same predicate fire. A claim whose only subject is the real tree is a claim
 * that reports clean on the day it stops matching anything.
 */
export function walkOffenders(
  modules: readonly TestTierModuleText[],
  admitted: readonly string[],
): readonly string[] {
  return modules
    .filter(
      (module) =>
        !admitted.includes(module.relativePath) &&
        reachesRendererSource(module.source, module.relativePath),
    )
    .map((module) => ({
      module,
      walks: directoryWalkImports(module.source, module.relativePath),
    }))
    .filter((entry) => entry.walks.length > 0)
    .map((entry) => `${entry.module.relativePath}: ${entry.walks.join(", ")}`);
}

/**
 * The modules that read a file, reach renderer source, and do not use the walk.
 *
 * The escape is DERIVED rather than listed: a module whose reads reach no renderer
 * path — the tier gates that read a harness, the CI workflow, or a build output —
 * holds no opinion about what counts as console source and passes without being
 * added to a list.
 */
export function readerOffenders(
  modules: readonly TestTierModuleText[],
  admitted: readonly string[],
): readonly string[] {
  return modules
    .filter(
      (module) =>
        !admitted.includes(module.relativePath) && readsAFile(module.source, module.relativePath),
    )
    .filter(
      (module) =>
        !importsSharedWalk(module.source, module.relativePath) &&
        reachesRendererSource(module.source, module.relativePath),
    )
    .map((module) => module.relativePath);
}
