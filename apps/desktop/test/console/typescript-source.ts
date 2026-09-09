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
// AND THE READINGS THAT SIT DIRECTLY ON THE PARSE LIVE HERE WITH IT. A gate asks its
// own question of the tree, but the reductions under that question are the same three
// everywhere: what text is fixed at this node, what names does this binding declare,
// and what shape is a module handed to a parse. Those were written three, two, and four
// times respectively across this tier, with two of the copies byte-identical including
// the doc comment and one differing only in whether it admitted an absent node — which
// is how a tier comes to hold two readings of one question and reports neither.
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
 * One module as a source-text gate reads it: a name for a failure, and the text.
 *
 * The structural half of `ConsoleModuleText`, which satisfies it — declared HERE rather
 * than four times, once per gate, because it is the shape this module's own parse is
 * fed. A planted control is written as the two fields a reading actually consumes
 * instead of as a synthetic walk entry carrying two absolute paths that name nothing,
 * and `ConsoleSourceTree.reading.texts` is assignable to it unchanged.
 */
export interface SourceModuleText {
  readonly displayPath: string;
  readonly source: string;
}

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

/**
 * A string whose value is fixed at the node — quoted, or a template with no substitution.
 *
 * The reduction every source-text gate performs on the one argument it cares about: a
 * glob pattern, a declared site, a module specifier. Three gates wrote it, two taking
 * `ts.Node` and one `ts.Node | undefined`, which is the wider of the two and therefore
 * the one signature that serves them all — a caller holding a node passes it, and a
 * caller holding a member that may be absent does not write the guard again.
 *
 * `undefined` is the REFUSAL and not an absence: a pattern composed from a constant or
 * an interpolation is one the parse cannot reduce, and every caller reads that as the
 * fail-closed arm rather than skipping the node.
 */
export function literalTextOf(node: ts.Node | undefined): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

/**
 * Every name one binding declares, destructuring patterns included.
 *
 * Written byte-for-byte twice — `cap-single-home.test.ts` and
 * `refusal-declaration-single-home.test.ts`, doc comment included — and both ask the
 * same question of the same node kind: which identifiers does this declaration bring
 * into scope. Accumulating INTO a caller's array rather than answering one is what the
 * recursion wants: a variable statement's declarations fold into one list.
 */
export function boundNamesOf(name: ts.BindingName, into: string[]): void {
  if (ts.isIdentifier(name)) {
    into.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      boundNamesOf(element.name, into);
    }
  }
}
