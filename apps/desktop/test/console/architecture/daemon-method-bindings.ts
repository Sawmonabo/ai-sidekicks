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
// the enclosing form downward" discipline `daemon-call-census.ts` states.
//
// AND AN UNREADABLE BINDING REFUSES RATHER THAN FALLS BACK. A destructured name, a
// namespace import, a parameter with no declared literal type, a `const` bound to
// anything but a string — each is recorded as a binding this parse cannot reduce, and
// resolving one answers the empty set. Falling through to the name index instead is
// what produced the shadow bug: the fallback fires exactly when the local answer is
// unavailable, which is exactly when guessing is least defensible.
//
// THE ONE INDEX THAT SURVIVES IS THE CROSS-MODULE ONE, and it is now reached only
// through an IMPORT. Two call sites name a constant `agents/agent-wire.ts` declares,
// and the nearest binding for those is the import specifier — so the index is asked
// for the EXPORTED name that specifier came from, rather than for whatever local
// spelling the call happened to use.

import ts from "typescript";

import { parseSourceText } from "../typescript-source.js";

/** What a name a call passes as its method is bound to, once the nearest binding is found. */
export type MethodBinding =
  /** A declaration this parse reduced to string literals — a parameter's union, or a `const`. */
  | { readonly kind: "literals"; readonly literals: readonly string[] }
  /** An import specifier: the index below is asked for the name it was exported under. */
  | { readonly kind: "imported"; readonly exportedName: string }
  /** A declaration this parse cannot reduce. Resolving one answers nothing. */
  | { readonly kind: "unreadable" };

/**
 * The method literals a `const` name is bound to, folded across a whole scan.
 *
 * A NAME AND NOT AN IMPORT GRAPH. Two of the console's call sites name a constant
 * declared in another module (`agents/agent-wire.ts`' two driver methods), and
 * resolving those through the import graph would mean a module resolver in a source
 * scan that deliberately has none. Folding every module's bindings under their names
 * answers the same question with the tree it already walked: a name bound to exactly
 * one registered method anywhere resolves to it, and a name two modules bind to two
 * different methods resolves to neither, because a scan that guessed between them
 * would be reporting on whichever module it happened to walk last.
 *
 * ONLY REGISTERED METHODS ARE INDEXED, and only what an IMPORT reached is asked of
 * this index at all. A console module binds constants for many things; admitting them
 * all would let an unrelated string shadow a method name, and the ambiguity refusal
 * above is the second half of the same guard.
 */
export class DaemonMethodConstantIndex {
  readonly #methodsByName = new Map<string, Set<string>>();
  readonly #registeredMethods: readonly string[];

  /**
   * @param registeredMethods Every method the daemon-reply registry binds a schema for.
   */
  public constructor(registeredMethods: readonly string[]) {
    this.#registeredMethods = registeredMethods;
  }

  /** Fold one module's `const NAME = "<method>"` bindings in. */
  public add(source: string, fileName: string): void {
    for (const statement of parseSourceText(fileName, source).statements) {
      if (!ts.isVariableStatement(statement)) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        const bound = this.#registeredMethodIn(declaration.initializer);
        if (ts.isIdentifier(declaration.name) && bound !== undefined) {
          const methods = this.#methodsByName.get(declaration.name.text) ?? new Set<string>();
          methods.add(bound);
          this.#methodsByName.set(declaration.name.text, methods);
        }
      }
    }
  }

  /** The methods this name resolves to: one, or none where it is absent or ambiguous. */
  public resolve(name: string): readonly string[] {
    const methods = this.#methodsByName.get(name);
    return methods === undefined || methods.size !== 1 ? [] : [...methods];
  }

  /** The registered method an initializer is, or `undefined` for everything else. */
  #registeredMethodIn(initializer: ts.Expression | undefined): string | undefined {
    if (initializer === undefined) {
      return undefined;
    }
    const literal = withoutTypeWrappers(initializer);
    if (!ts.isStringLiteralLike(literal)) {
      return undefined;
    }
    return this.#registeredMethods.includes(literal.text) ? literal.text : undefined;
  }
}

/** One lexical scope of a module, with everything declared directly in it. */
interface BindingScope {
  readonly start: number;
  readonly end: number;
  readonly bindingsByName: Map<string, MethodBinding>;
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
    this.#walk(parsed, moduleScope);
  }

  /**
   * What the nearest binding of `name` at `position` is, or `undefined` where the
   * module declares none — an ambient or a global, which this scan cannot read either.
   */
  public resolve(name: string, position: number): MethodBinding | undefined {
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
    const scope: BindingScope = { start, end, bindingsByName: new Map<string, MethodBinding>() };
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
      for (const [name, literals] of parameterLiteralTypes(node, this.#aliasedUnions)) {
        scope.bindingsByName.set(name, literals);
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

  /** Record one declaration form in the scope that contains it. */
  #declare(node: ts.Node, scope: BindingScope): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      scope.bindingsByName.set(node.name.text, literalInitializerBinding(node.initializer));
      return;
    }
    if (ts.isImportSpecifier(node)) {
      scope.bindingsByName.set(node.name.text, {
        kind: "imported",
        exportedName: (node.propertyName ?? node.name).text,
      });
      return;
    }
    if (ts.isNamespaceImport(node) || ts.isBindingElement(node)) {
      const name = node.name;
      if (ts.isIdentifier(name)) {
        scope.bindingsByName.set(name.text, { kind: "unreadable" });
      }
      return;
    }
    if (ts.isImportClause(node) && node.name !== undefined) {
      scope.bindingsByName.set(node.name.text, { kind: "unreadable" });
    }
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
function parameterLiteralTypes(
  declaration: ts.SignatureDeclaration,
  aliasedUnions: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, MethodBinding> {
  const constraints = new Map<string, ts.TypeNode>();
  for (const typeParameter of declaration.typeParameters ?? []) {
    if (typeParameter.constraint !== undefined) {
      constraints.set(typeParameter.name.text, typeParameter.constraint);
    }
  }
  const bindingsByParameterName = new Map<string, MethodBinding>();
  for (const parameter of declaration.parameters) {
    if (!ts.isIdentifier(parameter.name)) {
      continue;
    }
    const literals =
      parameter.type === undefined
        ? []
        : literalTypesIn(parameter.type, constraints, aliasedUnions);
    bindingsByParameterName.set(
      parameter.name.text,
      literals.length > 0 ? { kind: "literals", literals } : { kind: "unreadable" },
    );
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
