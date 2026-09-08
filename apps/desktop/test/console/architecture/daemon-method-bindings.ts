// What the name a door call passes as its method is BOUND to, resolved lexically.
//
// A NAME IS NOT A KEY IN A REPOSITORY-WIDE INDEX. The first reading of this question
// consulted the enclosing parameters and then fell back to a fold of every
// `const NAME = "<method>"` in the tree, keyed by the name alone. That answers
// correctly for the two call sites that name an imported constant and wrongly for
// every shadow: an inner `const method = "repo.workspaceList"` under an outer
// `method` parameter typed `"session.join"` classified from the OUTER binding, so a
// site could read while the gate held it to the record rule. A gate that resolves a
// name to a declaration the call does not see is not reading the source.
//
// SO THE SCOPE CHAIN IS THE MODEL. Every binding form is recorded in the scope that
// contains it — a function's parameters in the function, a `const` in its block, an
// import specifier in the module — and a call resolves its identifier against the
// scopes that contain the CALL, innermost first, which is how the language itself
// answers. The first scope that binds the name is the answer and the search stops
// there; nothing below it is consulted, which is exactly what a shadow means.
//
// BY RANGE, BECAUSE THE SHARED PARSE LEAVES PARENT POINTERS OFF. The walk carries the
// scope it is inside rather than asking a node what encloses it, and records each
// scope's span so a call's position selects the chain. That is the same "decided from
// the enclosing form downward" discipline `daemon-call-census.ts` states. The one
// binding form that cannot be recorded on the way down is an IMPORT, because a
// specifier needs the module its own declaration names and a specifier reached by
// descent cannot be asked what encloses it — so the imports are declared from the
// statement list first, before the walk, which is the whole set of them.
//
// A DECLARED FUNCTION OR CLASS IS A BINDING TOO, AND ITS NAME IS HOISTED. Recording only
// variables and binding elements left `function callDaemon(…) { … }` invisible, so a call
// inside a scope holding one resolved past it to the module's import and was read as a
// door call the program never makes — the same shadow the name index produced, one
// declaration form later. A declaration's name binds in the scope that CONTAINS it and
// binds over the whole of it, so a call written above the declaration resolves to it
// exactly as the language runs it; every scope's bindings are recorded before any
// position is resolved, which is what makes hoisting fall out rather than be arranged.
//
// AND AN EXPRESSION'S NAME IS SCOPED TO ITSELF, which is the same rule read the other
// way. `const send = function callDaemon(…) { … }` binds that name inside its own body
// and nowhere else, so recording it in the enclosing scope would invent a shadow the
// language does not have — the opposite error, and the reason a class EXPRESSION opens a
// scope here while a class DECLARATION does not need one.
//
// AND A `var` IS SCOPED TO ITS FUNCTION AND NOT TO ITS BLOCK, which is the second thing
// hoisting means and the one a span-keyed walk gets wrong for free. Every declaration was
// recorded in the scope the walk happened to be inside, so `{ var method = … }` left the
// binding between those braces and a call two lines under them resolved to whatever the
// name meant further out. The runtime reads the `var`; the gate read the shadow — and in
// the direction that exempts, since the name further out is routinely a record and a
// record is asked for no signal. So the walk carries a second scope beside the enclosing
// one, the nearest FUNCTION scope, and hands a non-block-scoped declaration list that one.
// Hoisting to the module instead would be the opposite error at the same seam: a `var` in
// one function would shadow the door's own import for every other function in the file.
//
// AND A CLASS STATIC BLOCK IS A VARIABLE SCOPE, which is where that second scope stops.
// A static initialization block runs once with a variable environment of its own, so a
// `var` inside one reaches nothing after the class — and a walk that knew only which
// scopes a BLOCK opens would carry such a name past the class body into the enclosing
// function or the module, where it can overwrite the door's own import. It is the only
// variable scope in the language that is neither function-like nor a module body, which is
// why it is named here rather than falling out of `ts.isFunctionLike`.
//
// WHAT A NODE DECLARES INTO THE SCOPES THIS WALK SELECTS is
// `daemon-method-binding-declarations.ts`', and what a declaration REDUCES TO is
// `daemon-method-literals.ts`'. Which scope a name belongs in is a question about spans
// and enclosing forms; what the name is worth is a question about initializers and type
// nodes with nothing lexical in them. This file answers the first and hands the node to
// the other two, which is what leaves the scope chain the one job it has.

import ts from "typescript";

import {
  declareBindingsOf,
  declareImports,
  parameterBindings,
  type BindingScope,
  type NameBinding,
} from "./daemon-method-binding-declarations.js";
import { moduleLiteralUnionAliases } from "./daemon-method-literals.js";

/**
 * What a name at a position is bound to, re-exported from the scope chain that answers it.
 *
 * `resolve` is where a consumer meets a binding, so the type it hands back is named on the
 * module a consumer already imports rather than on the one that happens to build the
 * record — the split behind it is this pair's own and not a caller's to track.
 */
export type { NameBinding };

/**
 * Every lexical scope of one module, and what each of them binds.
 *
 * Built once per parse and asked per call. `resolve` takes the call's own position
 * because that is what selects the chain: a scope contains the call or it does not,
 * and among those that do the innermost is the one whose binding the language would
 * use.
 */
export class ModuleBindingScopes {
  readonly #scopes: BindingScope[] = [];
  readonly #aliasedUnions: ReadonlyMap<string, readonly string[]>;
  readonly #parsed: ts.SourceFile;

  public constructor(parsed: ts.SourceFile) {
    this.#parsed = parsed;
    this.#aliasedUnions = moduleLiteralUnionAliases(parsed);
    const moduleScope = this.#openScope(0, parsed.end);
    declareImports(parsed, moduleScope);
    this.#walk(parsed, moduleScope, moduleScope);
  }

  /**
   * What the nearest binding of `name` at `position` is, or `undefined` where the
   * module declares none — an ambient or a global, which this scan cannot read either.
   */
  public resolve(name: string, position: number): NameBinding | undefined {
    const containing = this.#scopes
      .filter((scope) => position >= scope.start && position < scope.end)
      .sort((inner, outer) => outer.start - inner.start);
    for (const scope of containing) {
      const binding = scope.bindingsByName.get(name);
      if (binding !== undefined) {
        return binding;
      }
    }
    return undefined;
  }

  #openScope(start: number, end: number): BindingScope {
    const scope: BindingScope = { start, end, bindingsByName: new Map<string, NameBinding>() };
    this.#scopes.push(scope);
    return scope;
  }

  /**
   * Descend, carrying both scopes a child's own name could belong to.
   *
   * The enclosing one and the one the child OPENS, because which of them a name binds in
   * is decided by the declaration form: a `function` or `class` DECLARATION names itself
   * to the scope around it, and a function or class EXPRESSION names itself to its own
   * body. Handing the declarations only the opened scope put every declared function's
   * name inside itself, which is a binding no caller can see.
   *
   * AND THE VARIABLE SCOPE BESIDE THEM, which is the enclosing scope for every form but
   * one: a `var` list is handed the nearest function, module or static block instead. It
   * travels as its own argument rather than being looked up, because the walk is the only
   * reader that knows which function a node sits in — the parse leaves parent pointers
   * off, so a node reached by descent cannot be asked. The list's own subtree is then
   * walked with that scope as its enclosing one, so a destructured `var` element lands
   * where the plain identifier beside it does rather than in the block it was written in.
   */
  #walk(node: ts.Node, enclosing: BindingScope, variableScope: BindingScope): void {
    node.forEachChild((child) => {
      const containing = hoistsPastBlocks(child) ? variableScope : enclosing;
      const opened = this.#scopeOpenedBy(child, containing);
      declareBindingsOf(child, containing, opened);
      this.#walk(child, opened, opensVariableScope(child) ? opened : variableScope);
    });
  }

  /**
   * The scope `node` opens, or the one it sits in.
   *
   * A function-like node opens the scope its PARAMETERS bind in and declares them
   * immediately, because their declared types are read against that same node's type
   * parameters. Its body block opens a scope of its own beneath this one, which is
   * what makes an inner `const` shadow an outer parameter.
   *
   * A CLASS EXPRESSION opens one for its own NAME, which is the one thing it binds that
   * nothing outside it can see. A class DECLARATION needs none: its name binds in the
   * scope around it and a reference from inside the body reaches that same binding.
   *
   * A CLASS STATIC BLOCK opens one so that the variable scope it is has a span to be
   * recorded against. Its body block opens a second beneath it, exactly as a function's
   * does, and the two nest rather than compete: both contain every call the block makes,
   * and the inner one is the first the chain consults.
   */
  #scopeOpenedBy(node: ts.Node, enclosing: BindingScope): BindingScope {
    if (ts.isFunctionLike(node)) {
      const scope = this.#openScope(node.getStart(this.#parsed), node.end);
      for (const [name, binding] of parameterBindings(node, this.#aliasedUnions)) {
        scope.bindingsByName.set(name, binding);
      }
      return scope;
    }
    if (
      ts.isBlock(node) ||
      ts.isCaseBlock(node) ||
      ts.isModuleBlock(node) ||
      ts.isCatchClause(node) ||
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isClassStaticBlockDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return this.#openScope(node.getStart(this.#parsed), node.end);
    }
    return enclosing;
  }
}

/**
 * Whether the names `node` declares belong to the nearest variable scope rather than here.
 *
 * The keyword is the whole test, and it is read off the LIST because that is the only node
 * carrying it: `let`, `const` and `using` are block-scoped and `var` is not, so a list with
 * none of those flags is the one form this walk lifts. `ts.NodeFlags.BlockScoped` is the
 * union of the three the language block-scopes, named rather than spelled out so a fourth
 * one the language adds arrives here rather than being silently hoisted.
 */
function hoistsPastBlocks(node: ts.Node): boolean {
  return ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0;
}

/**
 * Whether `node` opens a variable environment — the scope a hoisted `var` stops at.
 *
 * Three forms and no more: anything function-like, a namespace body (which the emitter
 * makes a function), and a class static block. A block, a `for` head, a `catch` clause and
 * a `case` block each open a LEXICAL scope and no variable one, which is the whole
 * distinction this predicate exists to keep separate from `#scopeOpenedBy`'s.
 */
function opensVariableScope(node: ts.Node): boolean {
  return (
    ts.isFunctionLike(node) || ts.isModuleBlock(node) || ts.isClassStaticBlockDeclaration(node)
  );
}
