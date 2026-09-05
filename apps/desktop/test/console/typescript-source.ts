// One TypeScript parse, shared by every console test that asks about source text.
//
// Two tiers ask questions of the tree rather than of the application: the budget
// tier asks which bindings a harness holds (`budget/module-bindings.ts`), and the
// architecture tier asks which bounded waits a launched body declares
// (`architecture/body-allowance-consumption.test.ts`). Both used to be answerable
// with a regular expression, and one of them was answered that way — until a
// side-effect `import "./setup.js";` let the pattern run on into the comments
// after it and report a symbol merely MENTIONED there as an imported binding,
// which is the false green the gate above it exists to prevent.
//
// A regular expression cannot see a declaration boundary, and every question
// asked here is about one. So the parse lives here, once, with its options
// stated once: `typescript` is already the toolchain's own compiler and the
// answer it gives is the answer the compiler gives.
//
// `setParentNodes` is deliberately off. Both walks descend from a node they were
// handed, and neither asks what encloses one — turning it on would allocate a
// parent pointer per node for a link nothing follows.
//
// The script kind comes from the name the caller passes, because one of the
// callers reads the whole console corpus and most of that corpus is `.tsx`. The
// same `<` opens a type assertion in a `.ts` file and a JSX element in a `.tsx`
// one, so the kind is not a formality: parsing a component as `.ts` is parsing
// it under the wrong grammar, and a parser that recovers from that quietly
// produces a statement list nobody wrote.

import ts from "typescript";

/**
 * Parse `sourceText` under the grammar its `fileName` names.
 *
 * `fileName` is a label rather than a path: nothing is read from disk here, and
 * a caller that has already read a file passes its name so a diagnostic can say
 * which text this was — and so this can tell TypeScript from TSX. A name with
 * neither extension parses as TypeScript, which is what a label without a
 * grammar in it should mean.
 */
export function parseSourceText(fileName: string, sourceText: string): ts.SourceFile {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false, scriptKind);
}

/**
 * Visit every node under `node`, depth first, excluding `node` itself.
 *
 * `forEachChild` walks one level and is what the compiler exposes; the recursion
 * over it is what a caller wants and is written once here rather than in each
 * walk that needs it.
 */
export function forEachDescendant(node: ts.Node, visit: (descendant: ts.Node) => void): void {
  node.forEachChild((child) => {
    visit(child);
    forEachDescendant(child, visit);
  });
}
