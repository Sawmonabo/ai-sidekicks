// WHICH BINDING IS THE DAEMON CALL DOOR, and which modules consume it.
//
// The identity half of the chokepoint next door. `daemon-reach-forms.ts` answers what a
// module did once it held the bridge's own `daemon` namespace; this file answers the
// prior question both that gate and the call scan rest on — whether a given callee, or a
// given import clause, is the door at all.
//
// A MODEL BESIDE ITS GATE, on the `barrel-census.ts` pattern, and a bench beside both.
// The gate reads the real console; the needles here take source text as a parameter, so
// `daemon-call-census.test.ts` drives them with sources written by hand to fail —
// shapes this tree does not contain and could not be asserted against. The gate keeps
// only what reads the real modules, which is the split the three files exist to hold.
//
// THE INSTRUMENT IS THE PARSER, and it was a set of regular expressions until a module
// was reworded to get past one. `callDaemon` is a thing the console's own prose says
// constantly — the registry header names the door, and a seam's header explains which
// namespaces it deliberately does NOT reach. Every text needle here had therefore been
// progressively narrowed to dodge comments: a negative lookahead, a `[^;{]*` that stops
// at a brace, a rule about the space Prettier does not write. Each narrowing is a hole as
// well as a fix, and the disposition a red gate on prose invites is rewording the
// comment, which is the false-green class this file exists to prevent.
//
// A COMMENT IS NOT A NODE. Reading the door off the syntax tree makes every one of those
// narrowings unnecessary and every one of those holes closed at once: prose cannot match,
// a string literal naming the door cannot match, and the aliased and computed spellings
// the regular expressions were extended one at a time to catch fall out of the same walk.
// Depth is still honestly non-exhaustive — a door handed through two helpers defeats a
// syntactic scan as it defeated a textual one — and the lint ban beside it remains a
// second, different claim rather than a closure of this one.
//
// AND THE DOOR ITSELF IS A BINDING, NEVER A SPELLING — the one reading this file's
// consumer census and the call scan beside it both make, of the same scopes. Matching a
// name against the door's spellings answered three questions wrongly at once. A nested
// `send` — a parameter, a local, a callback argument — SHADOWS an import of the door
// aliased to that spelling, and the language says the shadow wins while the name set
// said the door did; the exported spelling `callDaemon` was matched unconditionally, in
// modules that never imported it, so any function of that name would have been read as
// the door; and a NAMESPACE-borne door — `import * as daemonDoor from "<the door>"`
// followed by `daemonDoor.callDaemon(…)` — was matched by neither reading, so a module
// written that way contributed no calls to the site scan AND was counted no consumer
// here, which is a signal check passing over nothing while every count that protects it
// stays satisfied.
//
// SO `namesCallDoor` RESOLVES THE CALLEE, in the two binding forms a door call has and
// no third. An identifier is the door where it resolves to an import specifier that
// imported the door's own export — under the exported spelling or whatever the clause
// aliased it to, and from the module the paragraph below holds the specifier to, which is
// the `propertyName ?? name` reading the clause census makes of the same element. A
// MEMBER READ of the door — `X.callDaemon`, or `X["callDaemon"]` — is the door where `X`
// resolves to a NAMESPACE import, through the same scope chain at the same position, so
// a local `const daemonDoor = …` shadows the namespace exactly as a parameter shadows a
// named import and neither is a door call. The namespace's own local name is never
// matched: `import * as wire` reads the same as `import * as daemonDoor`, because what a
// module called a binding is not what the binding is.
//
// AND AN EXPORT IS A (MODULE, NAME) PAIR, which is the half a specifier carries and a
// spelling cannot. Resolving the callee to an import specifier said WHICH CLAUSE bound
// the name and nothing about where that clause pointed, so
// `import { callDaemon } from "./anywhere.js"` was the door — a module publishing a
// function of that spelling from anywhere in the tree was read as the bridge's own. The
// specifier the binding record already carries is now resolved against the importer's own
// path through `daemon-module-resolution.ts` and matched against the door's TWO homes:
// `bridge/daemon/daemon-reply.ts` declares `callDaemon` and `bridge/index.ts` re-exports
// it, and consumers in this tree write specifiers for both. A set and not a suffix match,
// because `…/index.ts` is every family's door.
//
// THE NAMESPACE FORM STILL IDENTIFIES BY EXPORT ALONE, and that is a limit rather than a
// choice: a namespace binds no specifier this record can carry — `NameBinding.method` is
// `unreadable` for it — and the shared parse leaves parent pointers off, so the clause a
// `ts.NamespaceImport` came from is unreachable from the binding it produced. So
// `X.callDaemon` off a namespace of some other module is read as the door and REPORTED,
// which is the fail-closed direction: the census over-counts a consumer rather than
// letting one through, and closing it would mean a second walk of the clauses keyed to
// the same resolution.
//
// THE REST OF THE HONEST LIMIT IS THE RESOLVER'S OWN. A BARE specifier names a package
// this walk does not reach and a specifier CLIMBING OUT of the scanned roots resolves to
// nothing, so an import of `callDaemon` written either way is not the door — refused and
// reported, never trusted.
//
// AND A MEMBER READ IS ONE PREDICATE FOR BOTH SPELLINGS. `daemonDoor.callDaemon` and
// `daemonDoor["callDaemon"]` are the same read of the same export off the same binding,
// and the language resolves them identically — so `readsMember` reads the member however
// the key was written, and `namesCallDoor` and `importsCallDoor` share it. Admitting only
// the dotted form left the bracketed one matched by NEITHER: the site scan skipped the
// callee and the clause census below skipped the module, so the pinned consumer count
// did not move and an unsignalled read behind that spelling passed every gate at once,
// which is the namespace form's own hole a second time under a different key. The
// predicate is EXPORTED for the same reason it is one predicate: `daemon-signal-argument.ts`
// asks the same question of a round's `signal` member, and a dotted-only copy of a rule
// stated here would be the two spellings drifting apart one module over.
//
// A COMPUTED KEY THAT IS NOT A LITERAL IS NOT RESOLVABLE AND STAYS A NON-MATCH.
// `daemonDoor[name]` requires deciding what `name` holds, which is a value rather than a
// binding — the depth limit `daemon-call-sites.ts` states, and the residual
// `child-process-reach.ts` records for the loader names it reads the same way. What is
// closed is every spelling that still says the member's name in the text, which is why
// the key admitted is a string literal or the no-substitution template that is one.
//
// AND A TRANSPARENT WRAPPER IS NOT A DIFFERENT EXPRESSION. Every reading here resolves a
// CALLEE or the OBJECT a member is read off, and the five wrappers `daemon-method-literals.ts`
// peels — a parenthesis, `as`, `satisfies`, `<T>` and a non-null `!` — leave both exactly
// what they were. A reader stopping at one saw no door in `(callDaemon as typeof
// callDaemon)(…)`, so the module stayed a counted consumer under its named import while the
// call it makes reached no scan at all — the namespace form's hole again, spelled with a
// cast — and read `(bridge.sidekicks.daemon.call)(…)` as no reach whatsoever. So the
// peeling runs at every one of those positions, through the ONE helper the method reading
// already uses; a second peeler beside a reading here is how a closed list drifts apart.
// It is never inside `readsMember`, which is a type guard: peeling there would hand back a
// verdict about one node and a narrowing about another.

import ts from "typescript";

import { forEachDescendant, parseSourceText } from "../typescript-source.js";
import { ModuleBindingScopes } from "./daemon-method-bindings.js";
import { withoutTypeWrappers, type MethodBinding } from "./daemon-method-literals.js";
import { specifierNamesModule } from "./daemon-module-resolution.js";

/**
 * The door's consumer-facing name, as `bridge/index.ts` publishes it.
 *
 * Declared here because the two questions asked of it — which specifier imported THIS
 * export, and whether a callee resolves to one — are both answered in this file, and a
 * second declaration of the name beside either would be a closed set written twice.
 */
const CALL_DOOR_EXPORT = "callDaemon";

/**
 * The two modules that export IS published from, as the console walk names them.
 *
 * `bridge/daemon/daemon-reply.ts` declares it and `bridge/index.ts` re-exports it, and
 * both are homes because both are reached: the seven modules inside the bridge family
 * import the declaring module directly, and the nine outside it — the shell's two
 * included — go through the family door. Declared beside the export's own name because
 * the identity is the PAIR, so moving or re-homing the door is an edit a reviewer sees
 * in this file rather than a rule about how a barrel happens to be spelled.
 */
const CALL_DOOR_MODULES: readonly string[] = [
  "console/bridge/daemon/daemon-reply.ts",
  "console/bridge/index.ts",
];

/**
 * What a source with no path of its own is read as, which is a PLANTED console module.
 *
 * The default was `"probe.ts"` while the door was a name, and a name needs no path. It
 * needs one now: a specifier is resolved against its importer, so a probe named at the
 * scan's root resolves `"../bridge/index.js"` out of the scanned tree and the door it
 * planted stops being the door. A console-relative spelling is what the real callers
 * pass — `daemon-reply-chokepoint.test.ts` hands this the display path of every module
 * it walks — so the default is one too, and a bench states the clause it is about rather
 * than a path it has to keep in step.
 */
const PROBE_MODULE = "console/probe/surface.ts";

/**
 * Whether `callee` names the call door, through the binding it has at `position`.
 *
 * The rule this module's header states, applied: an identifier resolving to the door's
 * own import specifier, or a member read of the door off a namespace import, in either
 * case under whatever transparent wrappers the callee was written with. Both go
 * through the scope chain the caller already built, so the answer is the one the
 * language would give at that position and a nearer binding of either name wins.
 *
 * Exported because the call-site scan beside this one asks exactly this of every callee
 * it finds; a second reading there would be the same rule in two headers, which is a
 * rule that moves in one.
 *
 * @param importerPath What the scan names the module this callee is WRITTEN in, which is
 *   what the specifier its binding carries is resolved against.
 */
export function namesCallDoor(
  callee: ts.Expression,
  position: number,
  bindings: ModuleBindingScopes,
  importerPath: string,
): boolean {
  const named = withoutTypeWrappers(callee);
  if (ts.isIdentifier(named)) {
    return importsCallDoorExport(bindings.resolve(named.text, position)?.method, importerPath);
  }
  return readsDoorOffImportedNamespace(named, position, bindings);
}

/**
 * Whether a binding record is an import of the door's own export from one of its homes.
 *
 * BOTH HALVES OFF THE ONE RECORD. `NameBinding.method` already carries what an import
 * specifier came from — the name the OTHER module exports, whatever this one aliased it
 * to, and the specifier that names the module — so the reading is that record's own and
 * not a second walk of the clause. Every other binding form answers no, which is what
 * makes a nested `send` shadow an alias of the door rather than be read as one.
 */
function importsCallDoorExport(binding: MethodBinding | undefined, importerPath: string): boolean {
  return (
    binding?.kind === "imported" &&
    binding.exportedName === CALL_DOOR_EXPORT &&
    specifierNamesModule(importerPath, binding.moduleSpecifier, CALL_DOOR_MODULES)
  );
}

/**
 * Whether `node` reads the door's export off an IMPORTED MODULE NAMESPACE:
 * `daemonDoor.callDaemon`, or `daemonDoor["callDaemon"]`, which is the same read.
 *
 * The namespace here is an `import * as` binding and never the bridge's own `daemon`
 * namespace, which `readsCallDoor` below is about — two senses of one word, held apart
 * in the names because the two readings answer opposite questions about the same door.
 */
function readsDoorOffImportedNamespace(
  node: ts.Node,
  position: number,
  bindings: ModuleBindingScopes,
): boolean {
  if (!readsMember(node, CALL_DOOR_EXPORT)) {
    return false;
  }
  const namespace = withoutTypeWrappers(node.expression);
  if (!ts.isIdentifier(namespace)) {
    return false;
  }
  const declaration = bindings.resolve(namespace.text, position)?.declaration;
  return declaration !== undefined && ts.isNamespaceImport(declaration);
}

/**
 * Whether `source` CONSUMES the call door: it imports the door's own name, or reads the
 * door off a namespace it imported.
 *
 * Read off the import clause, which is what the regular expression this replaces spent
 * two narrowings approximating. `\bimport\b[^;]*\bcallDaemon\b` spanned newlines, so a
 * comment reading "a surface would import `callDaemon` from the bridge door" matched
 * it; requiring a brace between the two words fixed that one case and still matched a
 * comment that happened to contain one. An import clause is a node, and a comment is
 * not.
 *
 * A NAMESPACE IMPORT COUNTS ONLY WHERE THE MODULE READS THE DOOR OFF IT, which is this
 * census's half of the binding rule and the reason it is not answered by the clause
 * alone. `import * as bridge` binds no specifier to enumerate, so counting the clause
 * would attribute the door to every module that imports the family for anything at all;
 * skipping the shape entirely let a module reach the door, contribute no calls to the
 * scan beside this one, and stay outside the pinned consumer count — every gate green
 * over a module none of them could see. `daemonDoor.callDaemon` is the door read and is
 * counted, as is `daemonDoor["callDaemon"]`, through the one member reading the site
 * scan makes; `daemonDoor.formatRefusal` is not.
 *
 * A READ AND NOT A CALL, because a named import that is never invoked is counted too:
 * this census asks what a module CONSUMES and the site scan asks what a call says.
 * Holding the namespace form to the stricter test would make one pinned number move
 * differently for two spellings of one consumption.
 */
export function importsCallDoor(source: string, fileName: string = PROBE_MODULE): boolean {
  const parsed = parseSourceText(fileName, source);
  return callDoorLocalNames(parsed, fileName).size > 0 || readsCallDoorThroughNamespace(parsed);
}

/** Whether any expression in this module reads the door off a namespace binding. */
function readsCallDoorThroughNamespace(parsed: ts.SourceFile): boolean {
  const bindings = new ModuleBindingScopes(parsed);
  let consumed = false;
  forEachDescendant(parsed, (node) => {
    if (readsDoorOffImportedNamespace(node, node.getStart(parsed), bindings)) {
      consumed = true;
    }
  });
  return consumed;
}

/**
 * The LOCAL names this module reaches the door under, aliases included.
 *
 * `propertyName ?? name` IS THE READING, and it is the one the call-site scan makes
 * too — through the scope chain rather than through this set, because its subject is a
 * call and a name at a call position means whatever the nearest binding says it means.
 * Matching the exported spelling against a callee dropped every call an alias renamed,
 * so a module could be counted a consumer here and contribute no calls at all, which
 * is a signal check passing over nothing. Both readings now resolve the same clause
 * and share the one declaration of the name it is looked for under.
 *
 * A NAMESPACE import binds no specifier this clause reading can enumerate, so it is not
 * answered here at all — it is answered by the member read beside this one, for the
 * reason `importsCallDoor` states.
 *
 * AND THE CLAUSE'S OWN SPECIFIER DECIDES WHETHER IT IS THE DOOR AT ALL, which is this
 * reading's half of the (module, name) identity the header states. A clause naming any
 * other module exports some other `callDaemon`, and counting it made the pinned consumer
 * number a count of a spelling.
 */
function callDoorLocalNames(parsed: ts.SourceFile, importerPath: string): ReadonlySet<string> {
  const localNames = new Set<string>();
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    if (
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !specifierNamesModule(importerPath, statement.moduleSpecifier.text, CALL_DOOR_MODULES)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || ts.isNamespaceImport(bindings)) {
      continue;
    }
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === CALL_DOOR_EXPORT) {
        localNames.add(element.name.text);
      }
    }
  }
  return localNames;
}

/** A member read, in the two spellings that still say the member's name in the text. */
export type MemberRead = ts.PropertyAccessExpression | ts.ElementAccessExpression;

/**
 * Whether `node` reads `<something>.<member>`, however the key was spelled.
 *
 * The one reading this module's header states: `X.member` and `X["member"]` are the same
 * read of the same member off the same object, so one predicate answers both and every
 * consumer of it moves at once. A key that is not a literal is refused rather than
 * guessed at, for the reason the header gives.
 *
 * The narrowing is what the callers need beyond the boolean: both spellings carry the
 * object as `.expression`, which is the half a binding resolution is asked of.
 *
 * Exported for the consumers outside this module: `daemon-signal-argument.ts`' read of a
 * round's own `signal` member, and `daemon-read-round-receiver.ts`' read of the factory a
 * round was opened by. Those readings are about a value's provenance rather than about
 * the door, but the question each asks of the syntax is this one — and a dotted-only copy
 * beside a rule stated here is how two readings of one spelling drift apart.
 */
export function readsMember(node: ts.Node, member: string): node is MemberRead {
  return (
    readsMemberByDots(node, member) ||
    (ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === member)
  );
}

/**
 * Whether `node` reads `<something>.<member>`, spelled with a dot.
 *
 * Exported for `daemon-reach-forms.ts`, whose reach-form partition keys on the SPELLING
 * and so needs the dotted reading on its own — the header there states which two of its
 * readings take it and why folding them into the shared predicate would fold two form
 * names into one.
 */
export function readsMemberByDots(
  node: ts.Node,
  member: string,
): node is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(node) && node.name.text === member;
}
