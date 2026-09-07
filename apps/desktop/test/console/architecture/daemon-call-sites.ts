// Every call the console makes through the daemon door, read off the syntax tree.
//
// A MODEL BESIDE ITS GATE, on the `daemon-call-census.ts` pattern next door. That
// module answers WHICH modules reach the door; this one answers what each individual
// call at that door said — the method it named, and whether it handed the door a
// signal. They are two questions with two subjects (a module, a call) and the second
// one is the one a read-cancellation claim is about: `read-cancellation-chokepoint`
// held run-control dispatchers to naming no abort and had no complementary reading,
// so a read that simply forgot its signal was indistinguishable from a mutation that
// deliberately passes none. `DaemonCallOptions.signal` is optional by design, and
// absence being legal is exactly how two reads shipped without one.
//
// THE INSTRUMENT IS THE PARSER, for `daemon-call-census.ts`' reasons and one more of
// its own. A text needle for `{ signal }` matches the word in the prose of every
// module that explains why it passes one, and a needle for the method matches the
// registry's own table listing all thirty. Neither survives contact with this tree.
//
// AND THE METHOD IS RESOLVED RATHER THAN REQUIRED TO BE A LITERAL. Ten of the console's
// call sites name a module constant, one names a parameter typed as a union of two
// literals, and one names a generic type parameter — so a scan that read only string
// literals would report two thirds of the console unclassifiable and be ignored. Three
// resolutions cover every spelling in the tree, each of them a declaration this parse
// can read: a literal argument, a `const NAME = "<method>"` binding anywhere in the
// scan, and a parameter whose declared type is a union of string literals — reached
// through a type parameter's constraint and through a module-level type alias, both of
// which are how a narrowed binder spells its admissible method set.
//
// WHAT IS DELIBERATELY UNRESOLVED, and why that is the fail-closed direction. A method
// this parse cannot reduce to a set of registered names is reported with an empty set,
// and the gate holds such a site to the READ rule — because a call that could name a
// read and hands the door nothing to stop it is the defect whether or not today's
// callers happen to pass a mutation. The alternative reading, exempting what it cannot
// classify, is the hole this whole file exists to close.
//
// THE HONEST LIMIT. The door is matched by its own exported name, so a module that
// imported it under an alias is invisible here — `daemon-reply-chokepoint.test.ts`
// counts the door's consumers and would see that import, and this scan's own floor is
// asserted against that census rather than against a number written here.

import ts from "typescript";

import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** The door's consumer-facing name, as `bridge/index.ts` publishes it. */
const CALL_DOOR_EXPORT = "callDaemon";

/** Where the method name sits in the door's argument list. */
const METHOD_ARGUMENT_INDEX = 1;

/** Where `DaemonCallOptions` sits in it. */
const OPTIONS_ARGUMENT_INDEX = 3;

/** The member of those options that stops a read. */
const SIGNAL_MEMBER = "signal";

/** One call at the daemon door, as its own source text describes it. */
export interface DaemonCallSite {
  /** What a failure message names the module by. */
  readonly displayPath: string;
  /** One-based, so a failure reads like an editor's own location. */
  readonly line: number;
  /** The method argument as written — a literal, a constant, or a parameter name. */
  readonly methodExpression: string;
  /** Every registered method this call can name, or `[]` where none was resolved. */
  readonly resolvedMethods: readonly string[];
  /** Whether the options argument names {@link SIGNAL_MEMBER}. */
  readonly carriesSignal: boolean;
}

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
 * ONLY REGISTERED METHODS ARE INDEXED. A console module binds constants for many
 * things; admitting them all would let an unrelated string shadow a method name.
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

/** One function's own literal bindings, keyed by the identifier a call would name. */
interface FunctionLiteralScope {
  readonly start: number;
  readonly end: number;
  readonly methodsByParameterName: ReadonlyMap<string, readonly string[]>;
}

/**
 * Every door call in one module, with its method resolved and its signal read.
 *
 * TWO PASSES OVER ONE PARSE, AND NEITHER CLIMBS. The shared parse leaves parent
 * pointers off, so the functions enclosing a call are found by RANGE rather than by
 * asking the call what contains it: the first pass records every function-like node's
 * span and the literal types its parameters declare, and the second reads a call's
 * identifier against the spans that contain it, innermost first. That is the same
 * "decided from the enclosing form downward" discipline `daemon-call-census.ts`
 * states, applied to a question whose answer genuinely lives above the node.
 */
export function daemonCallSitesIn(
  displayPath: string,
  source: string,
  constants: DaemonMethodConstantIndex,
): readonly DaemonCallSite[] {
  const parsed = parseSourceText(displayPath, source);
  const aliasedUnions = moduleLiteralUnionAliases(parsed);
  const scopes: FunctionLiteralScope[] = [];
  const calls: ts.CallExpression[] = [];

  forEachDescendant(parsed, (node) => {
    if (ts.isFunctionLike(node)) {
      scopes.push({
        start: node.getStart(parsed),
        end: node.end,
        methodsByParameterName: parameterLiteralTypes(node, aliasedUnions),
      });
    }
    if (ts.isCallExpression(node) && isCallDoor(node.expression)) {
      calls.push(node);
    }
  });

  return calls.map((call) => {
    const method = call.arguments[METHOD_ARGUMENT_INDEX];
    return {
      displayPath,
      line: parsed.getLineAndCharacterOfPosition(call.getStart(parsed)).line + 1,
      methodExpression: method === undefined ? "" : method.getText(parsed),
      resolvedMethods: resolveMethods(method, call.getStart(parsed), scopes, constants),
      carriesSignal: namesSignal(call.arguments[OPTIONS_ARGUMENT_INDEX]),
    };
  });
}

/** Whether a call's callee is the door itself, reached by its own published name. */
function isCallDoor(callee: ts.Expression): boolean {
  return ts.isIdentifier(callee) && callee.text === CALL_DOOR_EXPORT;
}

/**
 * Whether the options argument names the signal member.
 *
 * FAIL-CLOSED ON EVERYTHING ELSE. A spread, a held variable, or a missing argument
 * each answer `false`, because none of them lets this parse SEE a signal — and
 * reporting a call as stoppable on the strength of a shape nothing read would be the
 * false green the gate above exists to prevent. Every options object in the console
 * today is written inline, so the strictness costs nothing and forbids a spelling that
 * would hide the member.
 */
function namesSignal(options: ts.Expression | undefined): boolean {
  if (options === undefined || !ts.isObjectLiteralExpression(options)) {
    return false;
  }
  return options.properties.some(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      ts.isIdentifier(property.name) &&
      property.name.text === SIGNAL_MEMBER,
  );
}

/** Every registered method the method argument can name, in the three resolvable shapes. */
function resolveMethods(
  method: ts.Expression | undefined,
  callStart: number,
  scopes: readonly FunctionLiteralScope[],
  constants: DaemonMethodConstantIndex,
): readonly string[] {
  if (method === undefined) {
    return [];
  }
  const named = withoutTypeWrappers(method);
  if (ts.isStringLiteralLike(named)) {
    return [named.text];
  }
  if (!ts.isIdentifier(named)) {
    return [];
  }
  return enclosingParameterLiterals(named.text, callStart, scopes) ?? constants.resolve(named.text);
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
function withoutTypeWrappers(expression: ts.Expression): ts.Expression {
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

/**
 * The literals a parameter of this name is declared to admit, or `undefined`.
 *
 * SEARCHED OUTWARD FROM THE CALL and not only at the tightest enclosing function,
 * because the console's one generic binder returns the door call inside an arrow: the
 * method is the OUTER function's parameter and the arrow that names it declares no
 * parameters at all. A reader that stopped at the innermost span reported that call
 * as naming nothing — the same manufactured offender the type-wrapper hole produced,
 * arrived at from the other side. Innermost first, so an inner parameter shadowing an
 * outer one answers as the language would.
 */
function enclosingParameterLiterals(
  name: string,
  position: number,
  scopes: readonly FunctionLiteralScope[],
): readonly string[] | undefined {
  const enclosing = scopes
    .filter((scope) => position >= scope.start && position < scope.end)
    .sort((inner, outer) => outer.start - inner.start);
  for (const scope of enclosing) {
    const literals = scope.methodsByParameterName.get(name);
    if (literals !== undefined) {
      return literals;
    }
  }
  return undefined;
}

/**
 * The string literals each of a function's parameters is declared to admit.
 *
 * Reached through TWO indirections that are how a narrowed method argument is really
 * spelled: a type parameter's constraint (`<MethodName extends DaemonMutationMethod>`)
 * and a module-level alias for the union itself. Both are declarations rather than
 * inferences, which is what keeps this a reading of the source rather than a partial
 * re-implementation of the checker.
 */
function parameterLiteralTypes(
  declaration: ts.SignatureDeclaration,
  aliasedUnions: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, readonly string[]> {
  const constraints = new Map<string, ts.TypeNode>();
  for (const typeParameter of declaration.typeParameters ?? []) {
    if (typeParameter.constraint !== undefined) {
      constraints.set(typeParameter.name.text, typeParameter.constraint);
    }
  }
  const methodsByParameterName = new Map<string, readonly string[]>();
  for (const parameter of declaration.parameters) {
    if (!ts.isIdentifier(parameter.name) || parameter.type === undefined) {
      continue;
    }
    const literals = literalTypesIn(parameter.type, constraints, aliasedUnions);
    if (literals.length > 0) {
      methodsByParameterName.set(parameter.name.text, literals);
    }
  }
  return methodsByParameterName;
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
