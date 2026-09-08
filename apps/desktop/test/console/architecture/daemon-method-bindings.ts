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
// AND AN UNREADABLE BINDING REFUSES RATHER THAN FALLS BACK. A destructured name, a
// namespace import, a parameter with no declared literal type, a `const` bound to
// anything but a string — each is recorded as a binding this parse cannot reduce, and
// resolving one answers the empty set. Falling through to the name index instead is
// what produced the shadow bug: the fallback fires exactly when the local answer is
// unavailable, which is exactly when guessing is least defensible.
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
// THE ONE INDEX THAT SURVIVES IS THE CROSS-MODULE ONE, and what a binding owes it is
// the MODULE and not just the name. Two call sites name a constant
// `agents/agent-wire.ts` declares, and the nearest binding for those is the import
// specifier — so an imported binding carries both halves of what its declaration
// says: the name the specifier came from, and the specifier's own module. What
// `daemon-method-constants.ts` then does with the pair is its subject; that a name
// alone is not enough to identify an export is this one's.
//
// AND THE DECLARATION TRAVELS WITH THE READING, because the method is not the only
// question a call site asks of a name. `daemon-call-sites.ts` asks whether the name a
// call INVOKES is the door's own import specifier, and `daemon-signal-argument.ts`
// asks what the value handed as the signal is bound to; both are answered from the
// declaration FORM — an import specifier, a parameter the caller filled in, a local a
// round was opened into — rather than from a string literal. Interpreting those here
// would put three subjects in this module; handing the declaration back leaves the
// scope chain with the one job it has, which is saying which declaration a name at a
// position means.
//
// AND WHAT A DECLARATION REDUCES TO IS `daemon-method-literals.ts`', for that same
// sentence's reason. An initializer's string literal and the literals a declared type
// admits are questions about expressions and type nodes with nothing lexical in them,
// and they sat here until the scope chain grew the declaration forms a hoisted
// `function` binds — at which point one file was holding the two subjects its own header
// says it does not.
//
// A VARIABLE IS DECLARED FROM ITS LIST AND NEVER FROM ITSELF, which is the one shape of
// this walk that a `const` rule dictates rather than the scope chain. `const` is a flag on
// the declaration LIST and the declarations under it carry none, and the shared parse
// leaves parent pointers off — so a walk that recorded each `VariableDeclaration` as it
// reached it could not see the keyword that binds it, and recorded `let method =
// "session.join"` as that method for the whole scope however many times the module wrote
// it afterwards. Matching the list and declaring its own declarations is what puts the
// keyword and the name in one place; the reduction itself, and the reason a scanner that
// FOLLOWED the writes was not built instead, are `daemon-method-literals.ts`'.

import ts from "typescript";

import {
  literalTypesIn,
  moduleLiteralUnionAliases,
  variableDeclarationBinding,
  type MethodBinding,
} from "./daemon-method-literals.js";

/**
 * What one name is bound to, in every reading a call site takes of a binding.
 *
 * One record and not two maps, so a name is bound in exactly one scope for every
 * question: a second map would let two readings disagree about WHICH declaration a
 * name at a position means, which is the shadow this module exists to refuse.
 */
export interface NameBinding {
  /** What this name means where a call passes it as its METHOD. */
  readonly method: MethodBinding;
  /** The declaration itself, for the questions this module does not answer. */
  readonly declaration: ts.Declaration;
}

/** One lexical scope of a module, with everything declared directly in it. */
interface BindingScope {
  readonly start: number;
  readonly end: number;
  readonly bindingsByName: Map<string, NameBinding>;
}

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
    this.#walk(parsed, moduleScope);
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
   * body. Handing `#declare` only the opened scope put every declared function's name
   * inside itself, which is a binding no caller can see.
   */
  #walk(node: ts.Node, scope: BindingScope): void {
    node.forEachChild((child) => {
      const inner = this.#scopeOpenedBy(child, scope);
      this.#declare(child, scope, inner);
      this.#walk(child, inner);
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
      ts.isClassExpression(node)
    ) {
      return this.#openScope(node.getStart(this.#parsed), node.end);
    }
    return enclosing;
  }

  /**
   * Record one declaration form in the scope its own name belongs to.
   *
   * `enclosing` for the three forms that name the scope around them — a variable, a
   * destructured element, and a hoisted `function` or `class` declaration — and `opened`
   * for the two that name only themselves, a function or class EXPRESSION. A declared
   * function is recorded as UNREADABLE rather than left unbound because it IS the binding
   * a call in that scope names, and looking past it is the shadow this module refuses;
   * what it is bound to is not a method this parse can reduce, which is what unreadable
   * says.
   *
   * A variable is matched at its LIST and its own declarations are recorded from there,
   * for the reason this module's header gives; the declaration itself is still what the
   * binding carries, because that is what the readings this module does not answer are
   * asked of.
   *
   * Imports are not among them — they are declared from the statement list before this
   * walk starts, for the reason this module's header gives.
   */
  #declare(node: ts.Node, enclosing: BindingScope, opened: BindingScope): void {
    if (ts.isVariableDeclarationList(node)) {
      for (const declaration of node.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          enclosing.bindingsByName.set(declaration.name.text, {
            method: variableDeclarationBinding(node, declaration),
            declaration,
          });
        }
      }
      return;
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      declareUnreadable(node.name, node, enclosing);
      return;
    }
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      declareUnreadable(node.name, node, enclosing);
      return;
    }
    if (ts.isFunctionExpression(node) || ts.isClassExpression(node)) {
      declareUnreadable(node.name, node, opened);
    }
  }
}

/**
 * Record one name as a binding this parse cannot reduce, where the declaration has one.
 *
 * A default-exported `function` and an anonymous `class` expression each name nothing,
 * and a form that binds no name shadows no name.
 */
function declareUnreadable(
  name: ts.Identifier | undefined,
  declaration: ts.Declaration,
  scope: BindingScope,
): void {
  if (name !== undefined) {
    scope.bindingsByName.set(name.text, { method: { kind: "unreadable" }, declaration });
  }
}

/**
 * Every imported name of one module, declared in its module scope.
 *
 * FROM THE STATEMENT LIST, because an import specifier's reading needs the module its
 * own declaration names and the shared parse leaves parent pointers off. An import is
 * always a top-level statement, so the statements ARE the whole set — a walk would
 * reach the same specifiers and arrive at each of them holding nothing that says which
 * declaration it belongs to.
 *
 * A specifier whose declaration names its module with anything but a string literal is
 * recorded unreadable rather than left unbound: it IS the binding the call names, and
 * looking past it is the shadow this module refuses.
 */
function declareImports(parsed: ts.SourceFile, scope: BindingScope): void {
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) {
      continue;
    }
    const moduleSpecifier = ts.isStringLiteralLike(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : undefined;
    declareImportClause(statement.importClause, moduleSpecifier, scope);
  }
}

/** One clause's three binding forms: a default name, a namespace, and the specifiers. */
function declareImportClause(
  clause: ts.ImportClause,
  moduleSpecifier: string | undefined,
  scope: BindingScope,
): void {
  if (clause.name !== undefined) {
    scope.bindingsByName.set(clause.name.text, {
      method: { kind: "unreadable" },
      declaration: clause,
    });
  }
  const namedBindings = clause.namedBindings;
  if (namedBindings === undefined) {
    return;
  }
  if (ts.isNamespaceImport(namedBindings)) {
    scope.bindingsByName.set(namedBindings.name.text, {
      method: { kind: "unreadable" },
      declaration: namedBindings,
    });
    return;
  }
  for (const element of namedBindings.elements) {
    scope.bindingsByName.set(element.name.text, {
      method:
        moduleSpecifier === undefined
          ? { kind: "unreadable" }
          : {
              kind: "imported",
              exportedName: (element.propertyName ?? element.name).text,
              moduleSpecifier,
            },
      declaration: element,
    });
  }
}

/**
 * The string literals each of a function's parameters is declared to admit.
 *
 * Reached through TWO indirections that are how a narrowed method argument is really
 * spelled: a type parameter's constraint (`<MethodName extends DaemonMutationMethod>`)
 * and a module-level alias for the union itself. Both are declarations rather than
 * inferences, which is what keeps this a reading of the source rather than a partial
 * re-implementation of the checker. A parameter whose type reduces to no literal is
 * recorded as unreadable rather than left unbound — it IS the binding the call names,
 * and looking past it is the shadow this module refuses.
 */
function parameterBindings(
  declaration: ts.SignatureDeclaration,
  aliasedUnions: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, NameBinding> {
  const constraints = new Map<string, ts.TypeNode>();
  for (const typeParameter of declaration.typeParameters ?? []) {
    if (typeParameter.constraint !== undefined) {
      constraints.set(typeParameter.name.text, typeParameter.constraint);
    }
  }
  const bindingsByParameterName = new Map<string, NameBinding>();
  for (const parameter of declaration.parameters) {
    if (!ts.isIdentifier(parameter.name)) {
      continue;
    }
    const literals =
      parameter.type === undefined
        ? []
        : literalTypesIn(parameter.type, constraints, aliasedUnions);
    bindingsByParameterName.set(parameter.name.text, {
      method: literals.length > 0 ? { kind: "literals", literals } : { kind: "unreadable" },
      declaration: parameter,
    });
  }
  return bindingsByParameterName;
}
