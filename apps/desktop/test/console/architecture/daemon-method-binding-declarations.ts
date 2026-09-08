// What one node DECLARES, and which of the two scopes it is handed the name belongs in.
//
// THE THIRD SUBJECT OF THE SCOPE CHAIN, split out of it on the seam that module's own
// header draws. `daemon-method-bindings.ts` says which scopes are open at a position and
// hands each node the two its name could belong to; this file says what the node declares
// into them; `daemon-method-literals.ts` says what a declaration this parse can read
// reduces to. They were two files until the walk grew a variable scope, a caught binding
// and a class static block, at which point the scope chain was carrying a closed set of
// declaration forms beside the spans that select them — the file its own header says it is
// not, "the scope chain with the one job it has".
//
// AND AN UNREADABLE BINDING REFUSES RATHER THAN FALLS BACK. A destructured name, a
// namespace import, a caught name, a parameter with no declared literal type, a `const`
// bound to anything but a string — each is recorded as a binding this parse cannot reduce,
// and resolving one answers the empty set. Falling through to a repository-wide name index
// instead is what produced the original shadow bug: the fallback fires exactly when the
// local answer is unavailable, which is exactly when guessing is least defensible.
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
//
// AND THE KEYWORD DECIDES THE SCOPE AS WELL AS THE READING, which is the same flag asked a
// second question. `let`, `const` and `using` bind in the block that contains them and
// `var` binds in the enclosing function, so the caller hands this file the scope it has
// already selected for the list rather than a block this file would have to hoist out of —
// the walk is the only place that knows which function a node sits in, and reading the
// keyword in two places would be one rule with two homes.
//
// A CAUGHT NAME IS A DECLARATION NO LIST CARRIES, and it needs a branch of its own for
// exactly that reason. `catch (method)` binds its name through a bare `VariableDeclaration`
// hung off the clause — no `VariableDeclarationList` over it and no `BindingElement` under
// it — so a walk reaching bindings only through those two forms opened the catch's scope
// and then declared nothing into it, and a call inside the handler resolved to whatever the
// name meant one scope out. The caught value is whatever was thrown, so it is recorded as a
// binding this parse cannot reduce; what it must never be is invisible.
//
// THE ONE INDEX THAT SURVIVES IS THE CROSS-MODULE ONE, and what a binding owes it is
// the MODULE and not just the name. Two call sites name a constant `agents/agent-wire.ts`
// declares, and the nearest binding for those is the import specifier — so an imported
// binding carries both halves of what its declaration says: the name the specifier came
// from, and the specifier's own module. What `daemon-method-constants.ts` then does with
// the pair is its subject; that a name alone is not enough to identify an export is this
// one's.
//
// AND THE DECLARATION TRAVELS WITH THE READING, because the method is not the only
// question a call site asks of a name. `daemon-call-sites.ts` asks whether the name a
// call INVOKES is the door's own import specifier, and `daemon-signal-argument.ts`
// asks what the value handed as the signal is bound to; both are answered from the
// declaration FORM — an import specifier, a parameter the caller filled in, a local a
// round was opened into — rather than from a string literal.
//
// AND THE FORM TRAVELS BECAUSE ONE FACT ABOUT IT CANNOT BE RECOVERED DOWNSTREAM. `const` is
// a flag on the LIST and parent pointers are off, so a consumer holding a
// `VariableDeclaration` cannot tell `const round = openRound()` from `let round = …`, and
// reading the two alike is a real defect: a held round is what a signal reading takes as
// the caller's obligation and a rebindable name is not. Every other site states its own.

import ts from "typescript";

import {
  literalTypesIn,
  variableDeclarationBinding,
  type MethodBinding,
} from "./daemon-method-literals.js";

/**
 * Which declaration form bound a name — the closed set this walk records, and no more.
 *
 * The two variable arms are why the type exists. The other five are stated so no site
 * defaults: `import` covers all three import forms, and one arm covers a function or class
 * however written, since which SCOPE it binds in is the scope chain's answer, not a
 * consumer's. `catch-binding` is its own arm rather than a seventh spelling of `parameter`
 * because the two differ in the one place a consumer reads: a caught name's declaration is
 * a `VariableDeclaration`, so every test that asks a parameter question of it answers no.
 */
export type BindingForm =
  | "constant"
  | "writable-variable"
  | "parameter"
  | "catch-binding"
  | "import"
  | "destructured"
  | "function-or-class";

/**
 * What one name is bound to, in every reading a call site takes of a binding.
 *
 * One record and not two maps, so a name is bound in exactly one scope for every
 * question: a second map would let two readings disagree about WHICH declaration a
 * name at a position means, which is the shadow this walk exists to refuse.
 */
export interface NameBinding {
  /** What this name means where a call passes it as its METHOD. */
  readonly method: MethodBinding;
  /** The declaration itself, for the questions this module does not answer. */
  readonly declaration: ts.Declaration;
  /** Which form declared it, for the one question the declaration cannot be asked. */
  readonly form: BindingForm;
}

/** One lexical scope of a module, with everything declared directly in it. */
export interface BindingScope {
  readonly start: number;
  readonly end: number;
  readonly bindingsByName: Map<string, NameBinding>;
}

/**
 * Record one declaration form in the scope its own name belongs to.
 *
 * `containing` for the four forms that name the scope around them — a variable, a
 * destructured element, a caught name, and a hoisted `function` or `class` declaration —
 * and `opened` for the two that name only themselves, a function or class EXPRESSION. The
 * caller selects `containing`: it is the enclosing scope for every form but a `var`, whose
 * list is handed the enclosing FUNCTION, because only the walk knows which one that is.
 *
 * A declared function is recorded as UNREADABLE rather than left unbound because it IS the
 * binding a call in that scope names, and looking past it is the shadow this walk refuses;
 * what it is bound to is not a method this parse can reduce, which is what unreadable says.
 *
 * A variable is matched at its LIST and its own declarations are recorded from there, for
 * the reason this module's header gives; the declaration itself is still what the binding
 * carries, because that is what the readings this module does not answer are asked of.
 *
 * Imports are not among them — they are declared from the statement list before the walk
 * starts, for the reason `daemon-method-bindings.ts`' header gives.
 */
export function declareBindingsOf(
  node: ts.Node,
  containing: BindingScope,
  opened: BindingScope,
): void {
  if (ts.isVariableDeclarationList(node)) {
    declareVariableList(node, containing);
    return;
  }
  if (ts.isCatchClause(node)) {
    declareCaughtName(node, opened);
    return;
  }
  if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
    declareUnreadable(node.name, node, containing, "destructured");
    return;
  }
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    declareUnreadable(node.name, node, containing, "function-or-class");
    return;
  }
  if (ts.isFunctionExpression(node) || ts.isClassExpression(node)) {
    declareUnreadable(node.name, node, opened, "function-or-class");
  }
}

/** Every name one declaration list binds directly, with the keyword its list carries. */
function declareVariableList(list: ts.VariableDeclarationList, scope: BindingScope): void {
  for (const declaration of list.declarations) {
    if (ts.isIdentifier(declaration.name)) {
      scope.bindingsByName.set(declaration.name.text, {
        method: variableDeclarationBinding(list, declaration),
        declaration,
        form: (list.flags & ts.NodeFlags.Const) === 0 ? "writable-variable" : "constant",
      });
    }
  }
}

/**
 * The name a `catch` clause binds, in the scope the clause opened.
 *
 * A clause binding nothing — `try { … } catch { … }` — declares nothing, on
 * `declareUnreadable`'s own rule: a form that binds no name shadows no name. A destructured
 * one is left to the binding elements under it, which the walk reaches inside this same
 * scope and which are already recorded as the unreadable bindings they are.
 */
function declareCaughtName(clause: ts.CatchClause, scope: BindingScope): void {
  const caught = clause.variableDeclaration;
  if (caught !== undefined && ts.isIdentifier(caught.name)) {
    declareUnreadable(caught.name, caught, scope, "catch-binding");
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
  form: BindingForm,
): void {
  if (name !== undefined) {
    scope.bindingsByName.set(name.text, { method: { kind: "unreadable" }, declaration, form });
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
 * looking past it is the shadow this walk refuses.
 */
export function declareImports(parsed: ts.SourceFile, scope: BindingScope): void {
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
      form: "import",
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
      form: "import",
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
      form: "import",
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
 * and looking past it is the shadow this walk refuses.
 */
export function parameterBindings(
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
      form: "parameter",
    });
  }
  return bindingsByParameterName;
}
