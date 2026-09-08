// What a round was OPENED OFF, which is the half a member name cannot answer.
//
// A SUBJECT ONE HOP OUT FROM ITS NEIGHBOUR'S. `daemon-signal-argument.ts` reads the
// value a call hands the door and asks what BINDING it came from; that reading ends at
// a name bound to a round, and this one starts there and asks what the round itself
// came from. They are held apart because the answers are found in different places —
// that one in the scope chain, this one in the scope chain AND in the class a field is
// declared on — and because putting both in one module put a file over the length its
// own package rules set.
//
// THE HOLE A FACTORY NAME LEFT, and it is the same hole one node deeper that the value
// reading already refuses. `opensRound` admitted ANY property-access call whose member
// was named `openRound`, so `const round = helper.openRound()` on an unrelated helper
// answering `{ signal: <a signal nothing abandons> }` read `"present"`, and a read
// nothing can stop passed the gate. A member NAMED `signal` is not a signal, by that
// module's own header; a call named `openRound` is not a round by the same sentence.
//
// SO THE RECEIVER IS RESOLVED, and what it must resolve to is a declaration this parse
// can see PRODUCE a read scope. One rule at three positions, which are the three
// `store/read-cancellation.ts` is consumed through:
//
//   - A CLASS'S OWN FIELD — `readonly #readLine = new ReadScope()` — read off `this`
//     inside that class, which is what every class-held read line writes.
//   - A `const` THAT MINTS ONE — `const readLine = new ReadScope()`, the shape a holder
//     that keeps its scope in a nullable field writes so the round is opened off a name
//     the checker has already narrowed.
//   - A `const` BOUND TO THE STORE'S DOOR — `const readScope = useReadScope(…)`, which
//     addresses a scope at the `(subject, key)` pairing a render owns.
//
// AND THE FACTORY ITSELF IS RESOLVED, NOT MATCHED BY NAME. `ReadScope` and
// `useReadScope` are the store's own exports or they are nothing: each name is taken
// through the same scope chain the round's receiver is, at its own position, and it is
// admitted only where the binding it lands on is an IMPORT SPECIFIER that imported that
// export FROM ONE OF THE STORE'S TWO HOMES — under whatever local alias the clause
// wrote. That is `daemon-call-census.ts`' own standard for the call door, applied here
// for the reason its header gives: a name is not an identity. Matching the spelling
// admitted `helper.useReadScope()` on a bare parameter, which is a scope this parse never
// saw declared, and a `class ReadScope` declared beside the read — both of them rounds
// nothing aborts, and both of them read `"present"` while an unstoppable read passed the
// gate.
//
// AND THE MODULE IS HALF OF THAT IDENTITY, because an export is a (module, name) pair
// and never a spelling. The scope chain answers which CLAUSE bound the name; the
// specifier that clause carries answers which MODULE it came from, and
// `daemon-module-resolution.ts` joins the two into the path the console walk names that
// module by. Both of the store's homes are admitted and no third is:
// `read-cancellation.ts` DECLARES the two exports and `store/index.ts` re-exports them,
// which is how every consumer in the tree reaches them — a family door for the six
// modules outside `store/` and the declaring module itself for the two inside it. A set
// rather than a suffix match, because `…/index.ts` is every family's door and admitting
// the suffix would put the whole tree back inside the identity this closes.
//
// WHETHER ANYBODY ABANDONS THAT SCOPE IS NOT ASKED, and the reason is that the answer is
// a claim about WRITES. A first cut of this rule refused the second form on the ground
// that a scope minted inside a function is superseded by nothing and abandoned by
// nobody — and the shell's provider-command holder mints exactly that scope, assigns it
// to its own field on the next line, and abandons it there when the address moves. The
// two shapes differ by an assignment this scan does not follow, so refusing on ownership
// would report a line that is correct. The limit is stated instead: this reading says
// the receiver IS a read scope, and who ends it is the same one-hop trust the forwarded
// signal arm takes one module over.
//
// AND A SCOPE HANDED IN IS NOT ADMITTED, which is the fail-closed direction rather than
// an oversight. A field the constructor fills (`readonly #readLine: ReadScope`) and a
// `ReadScope` parameter are both provenances the console does not write today, and a
// refusal on one is a call the gate REPORTS rather than a hole it leaves: the form is
// admitted by the change that first writes it, deliberately, and until then this reads
// what the console has. A door read off an imported NAMESPACE is refused on that same
// rule rather than on one of its own: every consumer in this tree names the export
// through a specifier, so the namespace form is a provenance the console does not write —
// and admitting it would mean identifying a module this parse cannot reach from the
// binding, since a specifier's own module travels on the binding record and a namespace
// import's does not. The ROUND's factory keeps both spellings of one read,
// `scope.openRound()` and `scope["openRound"]`, through `daemon-call-census.ts`' shared
// member predicate: that reading is about a member, and this one is about a binding.
//
// A FIELD IS SCOPED TO ITS CLASS AND NEVER TO THE MODULE. Two classes in one file can
// each declare `#readLine` with only one of them a scope, and a private name is
// reachable from nowhere but the class that declares it — so fields are recorded over
// the class's own span and the INNERMOST class containing the read decides, which is
// the same containing-span resolution `daemon-method-bindings.ts` makes for names. A
// class declaring no read-scope field is recorded all the same, because that is what
// makes an inner class shadow an outer one's field name rather than inherit its answer.
// The span is what stands in for the enclosing class: the shared parse leaves parent
// pointers off, so a receiver node here cannot be asked which class it sits in.
//
// AND THE POSITION IS THE RECEIVER'S OWN, not the call's. The two are ordinarily in one
// scope, and where they are not — a block between them rebinding the name — the binding
// the round was opened off is the one written at the OPEN, so resolving at the daemon
// call's position would answer with a binding that line never saw.
//
// THE HONEST LIMIT, AND IT IS THE DOOR CENSUS'S OWN. What remains open is the resolver's
// own fail-closed rule rather than a second identity: a BARE specifier names a package
// this walk does not reach and answers nothing, and a specifier CLIMBING OUT of the
// scanned roots answers nothing too — so an import of `useReadScope` written either way
// is refused and REPORTED, never trusted. That is the direction every other refusal here
// runs in: a name this module never imported, a class it declares itself, a member of a
// value handed in, and now a name imported from a module that is not the store's are each
// a scope this reading will not claim to have seen.

import ts from "typescript";

import { forEachDescendant } from "../typescript-source.js";
import { readsMember } from "./daemon-call-census.js";
import { type ModuleBindingScopes } from "./daemon-method-bindings.js";
import { withoutTypeWrappers } from "./daemon-method-literals.js";
import { specifierNamesModule } from "./daemon-module-resolution.js";

/** The scope's own factory, which is the call one round is opened by. */
const ROUND_FACTORY = "openRound";

/** The store's read-scope class, under the name `store/read-cancellation.ts` exports it. */
const READ_SCOPE_CLASS = "ReadScope";

/** The store's read-scope door, under the name that same module exports it. */
const READ_SCOPE_DOOR = "useReadScope";

/**
 * The two modules those exports have a home in, as the console walk names them.
 *
 * The module that DECLARES them and the family door that re-exports them, which are the
 * two paths every consumer in the tree writes a specifier for. Declared beside the names
 * themselves because the identity is the PAIR — one list rather than a rule about how a
 * barrel is spelled, so moving the seam is an edit a reviewer sees here.
 */
const READ_SCOPE_MODULES: readonly string[] = [
  "console/store/read/read-cancellation.ts",
  "console/store/index.ts",
];

/** One class's read-scope fields, over the span a `this` read of them can sit in. */
interface ClassFieldScope {
  readonly start: number;
  readonly end: number;
  /** Every field of this class whose declaration mints a read scope. Possibly none. */
  readonly readScopeFieldNames: ReadonlySet<string>;
}

/**
 * Every read scope one module can open a round off, and where each of them is reachable.
 *
 * Built once per parse and asked per round, on `ModuleBindingScopes`' shape and for its
 * reason: the class spans are a scope chain of their own — a field is reachable from
 * inside its class and nowhere else — and which of them a receiver at a position means
 * is the same containing-span question the name chain answers.
 */
export class ModuleReadScopes {
  readonly #fieldScopes: ClassFieldScope[] = [];
  readonly #bindings: ModuleBindingScopes;
  readonly #displayPath: string;

  /**
   * @param displayPath What the scan names this module by, which is what an import's own
   *   relative specifier resolves against.
   */
  public constructor(displayPath: string, parsed: ts.SourceFile, bindings: ModuleBindingScopes) {
    this.#displayPath = displayPath;
    this.#bindings = bindings;
    forEachDescendant(parsed, (node) => {
      if (ts.isClassLike(node)) {
        this.#fieldScopes.push({
          start: node.getStart(parsed),
          end: node.end,
          readScopeFieldNames: this.#readScopeFieldNamesOf(node),
        });
      }
    });
  }

  /**
   * Whether this initializer opened a round off a read scope this module can see.
   *
   * The factory read is `daemon-call-census.ts`' shared member predicate rather than a
   * dotted copy, so `scope.openRound()` and `scope["openRound"]` are the one read they
   * are; the receiver under it is then resolved, which is the whole of this reading.
   */
  public opensRound(initializer: ts.Expression | undefined): boolean {
    if (initializer === undefined) {
      return false;
    }
    const opened = withoutTypeWrappers(initializer);
    if (!ts.isCallExpression(opened)) {
      return false;
    }
    const factory = withoutTypeWrappers(opened.expression);
    return (
      readsMember(factory, ROUND_FACTORY) &&
      this.#namesReadScope(withoutTypeWrappers(factory.expression))
    );
  }

  /** Whether this receiver is a read scope, at either position one is declared. */
  #namesReadScope(receiver: ts.Expression): boolean {
    if (ts.isPropertyAccessExpression(receiver)) {
      return (
        withoutTypeWrappers(receiver.expression).kind === ts.SyntaxKind.ThisKeyword &&
        this.#declaresReadScopeField(receiver.name.text, receiver.end)
      );
    }
    return ts.isIdentifier(receiver) && this.#bindsReadScope(receiver.text, receiver.end);
  }

  /**
   * Whether the class this read sits in declares `fieldName` as a read scope.
   *
   * The innermost containing class and no other, because that is the only one a `this`
   * read reaches: a nested class's own field of the same name shadows the outer one,
   * and an outer class's private name is unreachable from inside a nested one at all.
   */
  #declaresReadScopeField(fieldName: string, position: number): boolean {
    const innermost = this.#fieldScopes
      .filter((scope) => position >= scope.start && position < scope.end)
      .sort((inner, outer) => outer.start - inner.start)[0];
    return innermost !== undefined && innermost.readScopeFieldNames.has(fieldName);
  }

  /**
   * Whether `name` at this position is a `const` bound to a read scope.
   *
   * The binding form carries the same weight it carries for a held round: a name the
   * scope may rebind says what it meant at the line that opened it and nothing about
   * what the round was opened off by the time this call runs. Both initializers a scope
   * arrives by are read here, the mint and the door, because which of the two a holder
   * writes is a question about where the scope lives rather than about what it is.
   */
  #bindsReadScope(name: string, position: number): boolean {
    const binding = this.#bindings.resolve(name, position);
    if (
      binding === undefined ||
      binding.form !== "constant" ||
      !ts.isVariableDeclaration(binding.declaration)
    ) {
      return false;
    }
    const { initializer } = binding.declaration;
    return this.#mintsReadScope(initializer) || this.#callsReadScopeDoor(initializer);
  }

  /**
   * Every field of one class whose declaration MINTS a read scope.
   *
   * A property declaration and never an accessor or a method: the reading is what the
   * class holds, and a member that computes an answer is a value this scan does not
   * follow. Both name spellings are recorded — a private name carries its own `#`, so
   * the set holds the text a receiver reads it back by.
   */
  #readScopeFieldNamesOf(declaration: ts.ClassLikeDeclaration): ReadonlySet<string> {
    const fieldNames = new Set<string>();
    for (const member of declaration.members) {
      if (
        ts.isPropertyDeclaration(member) &&
        (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name)) &&
        this.#mintsReadScope(member.initializer)
      ) {
        fieldNames.add(member.name.text);
      }
    }
    return fieldNames;
  }

  /** Whether this initializer constructs the store's own read scope: `new ReadScope()`. */
  #mintsReadScope(initializer: ts.Expression | undefined): boolean {
    if (initializer === undefined) {
      return false;
    }
    const minted = withoutTypeWrappers(initializer);
    if (!ts.isNewExpression(minted)) {
      return false;
    }
    const constructed = withoutTypeWrappers(minted.expression);
    return ts.isIdentifier(constructed) && this.#importsStoreExport(constructed, READ_SCOPE_CLASS);
  }

  /**
   * Whether this initializer opened a scope through the store's door: `useReadScope(…)`.
   *
   * The callee is a NAME and the name is resolved, for this module's header's reason: a
   * member of something handed in — `helper.useReadScope()` — is a factory this parse
   * never saw declared, and the scope it answers with is one nothing here can tie to a
   * read line.
   */
  #callsReadScopeDoor(initializer: ts.Expression | undefined): boolean {
    if (initializer === undefined) {
      return false;
    }
    const opened = withoutTypeWrappers(initializer);
    if (!ts.isCallExpression(opened)) {
      return false;
    }
    const door = withoutTypeWrappers(opened.expression);
    return ts.isIdentifier(door) && this.#importsStoreExport(door, READ_SCOPE_DOOR);
  }

  /**
   * Whether this name is bound, at its own position, to the store's `exportName`.
   *
   * The binding record already carries BOTH halves of what an import specifier came
   * from — the name the OTHER module exports, whatever this one aliased it to, and the
   * specifier that names the module it came from — so the reading is that record's own
   * and not a second walk of the clause. The specifier is resolved against this module's
   * own path, because a specifier is written at whatever depth its importer sits at and
   * `"../../store/index.js"` from one family is `"../store/index.js"` from another. Every
   * other binding form answers no: a parameter, a local, a class declared here, a name
   * this module never imported, and a name imported from somewhere else are each a
   * provenance that is not the store's export, which is the whole of the rule.
   */
  #importsStoreExport(named: ts.Identifier, exportName: string): boolean {
    const bound = this.#bindings.resolve(named.text, named.end)?.method;
    return (
      bound?.kind === "imported" &&
      bound.exportedName === exportName &&
      specifierNamesModule(this.#displayPath, bound.moduleSpecifier, READ_SCOPE_MODULES)
    );
  }
}
