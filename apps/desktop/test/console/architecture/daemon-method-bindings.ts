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

import ts from "typescript";

/** What a name a call passes as its method is bound to, once the nearest binding is found. */
export type MethodBinding =
  /** A declaration this parse reduced to string literals — a parameter's union, or a `const`. */
  | { readonly kind: "literals"; readonly literals: readonly string[] }
  /** An import specifier: the cross-module index is asked for this export of this module. */
  | {
      readonly kind: "imported";
      /** The name the specifier came from, which is the name the other module EXPORTS. */
      readonly exportedName: string;
      /** The specifier's own module, as the import spells it. */
      readonly moduleSpecifier: string;
    }
  /** A declaration this parse cannot reduce. Resolving one answers nothing. */
  | { readonly kind: "unreadable" };

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

  /** Descend, carrying the scope each child is declared in. */
  #walk(node: ts.Node, scope: BindingScope): void {
    node.forEachChild((child) => {
      const inner = this.#scopeOpenedBy(child, scope);
      this.#declare(child, inner);
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
      ts.isForInStatement(node)
    ) {
      return this.#openScope(node.getStart(this.#parsed), node.end);
    }
    return enclosing;
  }

  /**
   * Record one declaration form in the scope that contains it.
   *
   * Imports are not among them — they are declared from the statement list before this
   * walk starts, for the reason this module's header gives.
   */
  #declare(node: ts.Node, scope: BindingScope): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      scope.bindingsByName.set(node.name.text, {
        method: literalInitializerBinding(node.initializer),
        declaration: node,
      });
      return;
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      scope.bindingsByName.set(node.name.text, {
        method: { kind: "unreadable" },
        declaration: node,
      });
    }
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
 * An expression with its type-only wrappers peeled off.
 *
 * `satisfies`, `as`, an angle-bracket assertion and a parenthesis each wrap a value
 * without changing which one it is, and the console writes the first of them where it
 * matters most: the provider-readiness probe's method constant is
 * `"providerAccount.probe" satisfies MutatingDaemonMethod`, which is the store family's
 * classification checked at the declaration. A reader that stopped at the wrapper
 * reported that call as naming no method at all — an offender manufactured by the
 * instrument, from a module doing exactly the right thing.
 */
export function withoutTypeWrappers(expression: ts.Expression): ts.Expression {
  let inner = expression;
  while (
    ts.isSatisfiesExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isTypeAssertionExpression(inner) ||
    ts.isParenthesizedExpression(inner)
  ) {
    inner = inner.expression;
  }
  return inner;
}

/** What a `const` is bound to: its own string literal, or nothing this parse can read. */
function literalInitializerBinding(initializer: ts.Expression | undefined): MethodBinding {
  if (initializer === undefined) {
    return { kind: "unreadable" };
  }
  const literal = withoutTypeWrappers(initializer);
  return ts.isStringLiteralLike(literal)
    ? { kind: "literals", literals: [literal.text] }
    : { kind: "unreadable" };
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

/** The string literals a type node admits, following one constraint or alias hop. */
function literalTypesIn(
  type: ts.TypeNode,
  constraints: ReadonlyMap<string, ts.TypeNode>,
  aliasedUnions: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  if (ts.isLiteralTypeNode(type)) {
    return ts.isStringLiteralLike(type.literal) ? [type.literal.text] : [];
  }
  if (ts.isUnionTypeNode(type)) {
    const members = type.types.map((member) => literalTypesIn(member, constraints, aliasedUnions));
    return members.some((member) => member.length === 0) ? [] : members.flat();
  }
  if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) {
    return [];
  }
  const constraint = constraints.get(type.typeName.text);
  if (constraint !== undefined) {
    return literalTypesIn(constraint, new Map(), aliasedUnions);
  }
  return aliasedUnions.get(type.typeName.text) ?? [];
}

/** Every module-level `type NAME = "a" | "b"` in one file, by name. */
function moduleLiteralUnionAliases(parsed: ts.SourceFile): ReadonlyMap<string, readonly string[]> {
  const aliases = new Map<string, readonly string[]>();
  for (const statement of parsed.statements) {
    if (!ts.isTypeAliasDeclaration(statement)) {
      continue;
    }
    const literals = literalTypesIn(statement.type, new Map(), new Map());
    if (literals.length > 0) {
      aliases.set(statement.name.text, literals);
    }
  }
  return aliases;
}
