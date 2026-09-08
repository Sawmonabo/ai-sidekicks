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
export function literalInitializerBinding(initializer: ts.Expression | undefined): MethodBinding {
  if (initializer === undefined) {
    return { kind: "unreadable" };
  }
  const literal = withoutTypeWrappers(initializer);
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
