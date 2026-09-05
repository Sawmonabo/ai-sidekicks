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
// `setParentNodes` is deliberately off. Every walk descends from a node it was
// handed, and none asks what encloses one — turning it on would allocate a parent
// pointer per node for a link nothing follows. A caller that needs a node's own
// text passes the parsed file to `node.getText(parsed)`, which reads the source
// text it already has rather than climbing to it.
//
// THE SCRIPT KIND IS DERIVED FROM THE FILE NAME, not asked for. A `.tsx` module's
// rows are JSX elements, and parsed as `TS` a JSX opening tag reads as a
// comparison — so the windowed-row census would see no rows at all. Deriving it
// here rather than taking it as an argument means no caller can pass the wrong
// one for the text it is holding, and a caller reading a `.tsx` module gets JSX
// without knowing it had to ask.

import ts from "typescript";

/**
 * Parse `sourceText` as TypeScript.
 *
 * `fileName` is a label rather than a path: nothing is read from disk here, and
 * a caller that has already read a file passes its name so a diagnostic can say
 * which text this was — and so the script kind can be read off it.
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
