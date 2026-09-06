// How one file's import specifiers are read out of its text — the three readers the
// stylesheet gates ask their questions with.
//
// A MODULE OF READERS, because a reader is a claim about a GRAMMAR and the graph next
// door is a claim about a tree. `stylesheet-edge-graph.ts` composes these into a walk and
// `stylesheet-edges.test.ts` drives them against planted sources; keeping them here means
// neither file has to be read to understand what "an edge" is, and the graph module stays
// about the walk.
//
// EVERY ONE READS FROM A PARSE OR AN ANCHORED AT-RULE, never from a whole-line match. A
// pattern cannot tell an import from a sentence about one, so a header explaining WHY a
// module does not import a sheet was counted as the import it was explaining the absence
// of — and a specifier broken across two lines was counted as nothing at all.

import ts from "typescript";

import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/**
 * How a file's stylesheet specifiers are read out of it.
 *
 * A function per LANGUAGE rather than a pattern per shape, because the two questions
 * are asked of two grammars and neither is answerable by a line match. Both readers
 * take the file's name as well as its text: one needs it to choose a script kind, and
 * the other reports it.
 */
export type StylesheetSpecifierReader = (fileName: string, source: string) => readonly string[];

/**
 * Every stylesheet a TypeScript module imports for its side effect.
 *
 * READ FROM THE PARSE, because the question is about a declaration boundary and a
 * regular expression cannot see one. The pattern this replaced was a whole-LINE match,
 * so `import "./parks.css"; // ships with the parks module` was not an edge, and
 * neither was a specifier broken across two lines: the sheet then read as unreached
 * and the gate reported a tree with an orphaned stylesheet as clean. A side-effect
 * import is exactly `ts.isImportDeclaration(node) && node.importClause === undefined`,
 * and the specifier is the string literal the declaration already holds — no text
 * between the two for a pattern to run past.
 *
 * `.css` and nothing else, because this walk is about stylesheets and a module also
 * side-effect-imports polyfills and registries that are not sheets.
 */
export const moduleStylesheetImports: StylesheetSpecifierReader = (fileName, source) => {
  // A STYLESHEET HANDED HERE ANSWERS WITH ITS OWN AT-RULES, measured: TypeScript's
  // error recovery reads `@import "./surface.css";` as a decorator followed by a
  // side-effect import, so this reader is not blind to CSS by parsing alone. The walk
  // never hands it one — `CONSOLE_STYLESHEET_TREE.modulePaths` holds `.ts` and `.tsx`
  // — and this guard makes that a property of the reader rather than of its callers.
  if (!fileName.endsWith(".ts") && !fileName.endsWith(".tsx")) {
    return [];
  }
  const specifiers: string[] = [];
  const parsed = parseSourceText(fileName, source);
  forEachDescendant(parsed, (node) => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause === undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.endsWith(".css")
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
  });
  return specifiers;
};

/** A comment in a stylesheet, so a commented-out `@import` is not read as one. */
const CSS_COMMENT = /\/\*[\s\S]*?\*\//gu;

/** The head of an `@import` at-rule: the keyword and whatever follows it, to its end. */
const CSS_AT_IMPORT_PRELUDE = /@import\b(?<prelude>[^;{]*)/gu;

/** The target of an `@import` prelude, quoted directly or wrapped in `url()`. */
const CSS_IMPORT_TARGET =
  /url\(\s*(?<quoted>"[^"]*"|'[^']*'|[^)\s]*)\s*\)|"(?<double>[^"]*)"|'(?<single>[^']*)'/u;

/**
 * Every stylesheet an `@import` at-rule pulls into this sheet.
 *
 * ANCHORED ON THE AT-RULE, not on a line. The pattern this replaced matched a whole
 * line and required the closing `";` to end it, so an `@import` carrying a media
 * query, a cascade layer, or a trailing comment disappeared from the graph — and a
 * sheet reached only that way was reported as unreached while a sheet reached twice
 * was reported as reached once. The prelude runs from the keyword to the `;` or `{`
 * that ends it, and the target is the first string in it however it is written, which
 * is what the CSS grammar says an `@import` names.
 *
 * Comments are stripped first, so a commented-out `@import` is not an edge — the one
 * way this question can be asked wrongly that anchoring alone does not answer.
 */
export const stylesheetAtImports: StylesheetSpecifierReader = (_fileName, source) => {
  const withoutComments = source.replace(CSS_COMMENT, " ");
  const specifiers: string[] = [];
  for (const atRule of withoutComments.matchAll(CSS_AT_IMPORT_PRELUDE)) {
    const target = CSS_IMPORT_TARGET.exec(atRule.groups?.["prelude"] ?? "");
    if (target === null) {
      continue;
    }
    const quoted = target.groups?.["quoted"];
    const unwrapped =
      quoted === undefined
        ? (target.groups?.["double"] ?? target.groups?.["single"])
        : quoted.replace(/^["']|["']$/gu, "");
    if (unwrapped !== undefined && unwrapped !== "") {
      specifiers.push(unwrapped);
    }
  }
  return specifiers;
};

/**
 * Every dynamic `import()` specifier a module writes, as written. Relative only.
 *
 * Read from the parse for `moduleStylesheetImports`' reason: `import(` inside a comment
 * or a string is not a call expression, and a pattern cannot tell the difference. The
 * node is a call whose expression is the `import` keyword itself, which is the one
 * shape the grammar gives a dynamic import.
 */
export function dynamicImportSpecifiers(fileName: string, source: string): readonly string[] {
  if (!fileName.endsWith(".ts") && !fileName.endsWith(".tsx")) {
    return [];
  }
  const specifiers: string[] = [];
  const parsed = parseSourceText(fileName, source);
  forEachDescendant(parsed, (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0] as ts.Node)
    ) {
      specifiers.push((node.arguments[0] as ts.StringLiteral).text);
    }
  });
  return specifiers;
}

/**
 * Every module specifier a module names STATICALLY, as written. Relative only.
 *
 * `import`, `import type`, and `export … from` alike, because all three put the target
 * in the importing chunk's graph — a type-only edge does not, but the parser's own
 * `isTypeOnly` flag is not consulted here on purpose: the reach set this feeds is used
 * to REFUSE moving a stylesheet, and over-reporting refuses more than it must while
 * under-reporting would admit a move that breaks a surface.
 *
 * Dynamic `import()` is deliberately absent — it is `dynamicImportSpecifiers`' subject,
 * and the boundary between the two is the whole point of both.
 */
export function moduleStaticImportSpecifiers(fileName: string, source: string): readonly string[] {
  if (!fileName.endsWith(".ts") && !fileName.endsWith(".tsx")) {
    return [];
  }
  const specifiers: string[] = [];
  const parsed = parseSourceText(fileName, source);
  forEachDescendant(parsed, (node) => {
    const moduleSpecifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : undefined;
    if (moduleSpecifier !== undefined && ts.isStringLiteral(moduleSpecifier)) {
      specifiers.push(moduleSpecifier.text);
    }
  });
  return specifiers;
}
