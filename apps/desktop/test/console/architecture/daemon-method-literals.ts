// What a declaration REDUCES TO, where the thing it is bound to is a method name.
//
// THE SECOND SUBJECT OF THE SCOPE CHAIN, split out of it. `daemon-method-bindings.ts`
// says which declaration a name at a position means — a scope question, answered from
// spans and forms — and this file says what a declaration this parse CAN read reduces to,
// which is a question about initializers and type nodes and about nothing lexical at all.
// The two lived in one module until the scope chain grew the declaration forms a hoisted
// `function` binds, and a module holding both was the file its own header said it was not:
// "the scope chain with the one job it has".
//
// EVERY READING HERE IS A DECLARATION AND NEVER AN INFERENCE, which is what keeps this a
// reading of the source rather than a partial re-implementation of the checker. A `const`
// answers with its own string literal or with nothing; a parameter answers with the
// literals its declared type admits, through the two indirections a narrowed method
// argument is really spelled with — a type parameter's constraint and a module-level
// alias for the union — and through no third. What reduces to no literal is not guessed
// at: it is handed back as nothing, and the scope chain records it as a binding this
// parse cannot reduce, which is the fail-closed direction both files run in.
//
// AND AN INITIALIZER IS ONLY WHAT A BINDING HOLDS WHERE NOTHING CAN WRITE IT AGAIN, which
// is why the reduction takes the declaration LIST rather than the initializer alone. The
// keyword lives on the list — `const` sets a flag there and the declarations under it
// carry none — so a reader handed one declaration cannot see whether the name it binds is
// writable, and this reduction read `let method = "session.join"` as that method however
// many times the module reassigned it afterwards.
//
// TRACKING THE WRITES WAS THE OTHER WAY AND IS NOT TAKEN. A reader that followed
// assignments would have to order them against the call, follow them through branches and
// closures and out of the module, and answer with whichever value reaches a position — a
// dataflow engine, and one whose wrong answers look exactly like right ones. The contract
// the gate is written against is narrower and states itself: a method name is a literal at
// the call, or a closed union a parameter declares, or a `const` this parse can reduce.
// Anything writable is a binding this parse cannot reduce, and the gate reports the site
// rather than trusting a value that can be rewritten under it.

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
 * An expression with every transparent wrapper peeled off, to the value itself.
 *
 * THE CLOSED LIST IS FIVE, and the rule admitting them is that the emitter deletes each:
 * `as`, `satisfies`, an angle-bracket `<T>` assertion and a non-null `!` are type-level
 * and erase, and a parenthesis only groups — so what stands under the wrappers is the
 * value the program evaluates, and a reader stopping at one is reading a node the run
 * time does not have. Nothing else joins the list, because everything else CHOOSES a
 * value rather than restating one: a call, a member read, a conditional and an `await`
 * each produce something their operand is not, and peeling one would be following a value
 * rather than reading an expression.
 *
 * ONE PEELER AND NOT ONE PER READING, which is why this is exported rather than inlined
 * at each of the four scans that need it. The console writes the wrappers where they
 * matter most — the provider-readiness probe's method constant is
 * `"providerAccount.probe" satisfies MutatingDaemonMethod`, and a reader that stopped
 * there reported that call as naming no method at all, an offender manufactured by the
 * instrument — and the same wrappers around a CALLEE are the other direction of the same
 * defect: `(callDaemon as typeof callDaemon)(…)` is a door call that a reader stopping at
 * the wrapper sees no door in, so the module stays a counted consumer while the call it
 * makes reaches no scan at all. A second peeler written next to either reading would be
 * this list drifting apart one module over.
 */
export function withoutTypeWrappers(expression: ts.Expression): ts.Expression {
  let inner = expression;
  while (
    ts.isSatisfiesExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isTypeAssertionExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isParenthesizedExpression(inner)
  ) {
    inner = inner.expression;
  }
  return inner;
}

/**
 * What one variable declaration is bound to, read through the list that declares it.
 *
 * A `const` answers with its own string literal, and a `let` or a `var` answers with
 * nothing this parse can read — for the reason this module's header gives, and taking the
 * list because the list is where the keyword is.
 */
export function variableDeclarationBinding(
  declarationList: ts.VariableDeclarationList,
  declaration: ts.VariableDeclaration,
): MethodBinding {
  if ((declarationList.flags & ts.NodeFlags.Const) === 0 || declaration.initializer === undefined) {
    return { kind: "unreadable" };
  }
  const literal = withoutTypeWrappers(declaration.initializer);
  return ts.isStringLiteralLike(literal)
    ? { kind: "literals", literals: [literal.text] }
    : { kind: "unreadable" };
}

/** The string literals a type node admits, following one constraint or alias hop. */
export function literalTypesIn(
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
export function moduleLiteralUnionAliases(
  parsed: ts.SourceFile,
): ReadonlyMap<string, readonly string[]> {
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
