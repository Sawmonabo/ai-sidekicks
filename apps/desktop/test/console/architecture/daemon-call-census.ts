// The reach census the daemon-reply chokepoint next door runs: how a module shows it
// reached the bridge's call door, and how it shows it consumes it.
//
// A MODEL BESIDE ITS GATE, on the `barrel-census.ts` pattern, and a bench beside both.
// The gate reads the real console; the needles here take source text as a parameter, so
// `daemon-call-census.test.ts` drives them with sources written by hand to fail —
// shapes this tree does not contain and could not be asserted against. The gate keeps
// only what reads the real modules, which is the split the three files exist to hold.
//
// THE INSTRUMENT IS THE PARSER, and it was a set of regular expressions until a module
// was reworded to get past one. `daemon.call`, `window.sidekicks.daemon` and
// `callDaemon` are things the console's own prose says constantly — the bridge shape
// test names the member, the registry header names the door, and a seam's header
// explains which namespaces it deliberately does NOT reach. Every text needle here had
// therefore been progressively narrowed to dodge comments: a negative lookahead, a
// `[^;{]*` that stops at a brace, a rule about the space Prettier does not write. Each
// narrowing is a hole as well as a fix, and the one that mattered fired anyway — a
// bridge seam's header sentence naming the namespace it avoids turned the gate red, and
// the disposition a red gate on prose invites is rewording the comment, which is the
// false-green class this file exists to prevent.
//
// A COMMENT IS NOT A NODE. Reading the reaches off the syntax tree makes every one of
// those narrowings unnecessary and every one of those holes closed at once: prose
// cannot match, a string literal naming the method cannot match, and the aliased and
// computed spellings the regular expressions were extended one at a time to catch fall
// out of the same walk. Depth is still honestly non-exhaustive — a door handed through
// two helpers defeats a syntactic scan as it defeated a textual one — and the lint ban
// beside it remains a second, different claim rather than a closure of this one.
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
// no third. An identifier is the door where it resolves to the import specifier that
// imported it, under the exported spelling or whatever the clause aliased it to — the
// `propertyName ?? name` reading the clause census below makes of the same element. A
// MEMBER READ of the door — `X.callDaemon`, or `X["callDaemon"]` — is the door where `X`
// resolves to a NAMESPACE import, through the same scope chain at the same position, so
// a local `const daemonDoor = …` shadows the namespace exactly as a parameter shadows a
// named import and neither is a door call. The namespace's own local name is never
// matched: `import * as wire` reads the same as `import * as daemonDoor`, because what a
// module called a binding is not what the binding is.
//
// AND THE MODULE A NAMESPACE NAMES IS DELIBERATELY NOT CONSULTED, for the reason the
// named form does not consult it either: the door is identified by the EXPORT a call
// reaches for, and a specifier is written at whatever depth its importer sits at, so
// matching one would be a second and weaker identity for the same export — one that
// fails OPEN on every spelling it did not anticipate, which is the direction this whole
// file exists to refuse. `X.callDaemon` off a namespace of some other module is
// therefore read as the door and reported, exactly as
// `import { callDaemon } from "./anywhere.js"` has always been.
//
// AND A MEMBER READ IS ONE PREDICATE FOR BOTH SPELLINGS. `daemonDoor.callDaemon` and
// `daemonDoor["callDaemon"]` are the same read of the same export off the same binding,
// and the language resolves them identically — so `readsMember` reads the member however
// the key was written, and `namesCallDoor` and `importsCallDoor` share it. Admitting only
// the dotted form left the bracketed one matched by NEITHER: the site scan skipped the
// callee and the clause census below skipped the module, so the pinned consumer count
// did not move and an unsignalled read behind that spelling passed every gate at once,
// which is the namespace form's own hole a second time under a different key.
//
// A COMPUTED KEY THAT IS NOT A LITERAL IS NOT RESOLVABLE AND STAYS A NON-MATCH.
// `daemonDoor[name]` requires deciding what `name` holds, which is a value rather than a
// binding — the depth limit `daemon-call-sites.ts` states, and the residual
// `child-process-reach.ts` records for the loader names it reads the same way. What is
// closed is every spelling that still says the member's name in the text, which is why
// the key admitted is a string literal or the no-substitution template that is one.
//
// THE REACH FORMS BELOW PARTITION BY SPELLING ON PURPOSE, which is why two readings
// there stay dotted rather than taking the shared one. `namesDaemonNamespaceByDots` IS
// the fully dotted spelling — the computed ones are reported as forms of their own,
// "namespace taken by computed key" and "called by computed key" — and the `.call` step
// of `readsCallDoor` is dotted for the same reason: its bracketed spelling already has a
// form name, and folding the two would fold two form names into one. Every OTHER member
// read here takes the shared predicate, the computed-key form's own bridge step
// included, so `bridge["sidekicks"]["daemon"]` is reported rather than falling between
// two readings.

import ts from "typescript";

import { forEachDescendant, parseSourceText } from "../typescript-source.js";
import { ModuleBindingScopes } from "./daemon-method-bindings.js";

/** The bridge namespace whose call door is governed. */
const DAEMON_NAMESPACE = "daemon";

/** The bridge object the namespace hangs off. */
const BRIDGE_NAMESPACE = "sidekicks";

/** The door itself. */
const CALL_MEMBER = "call";

/**
 * The door's consumer-facing name, as `bridge/index.ts` publishes it.
 *
 * Declared here because the two questions asked of it — which specifier imported THIS
 * export, and whether a callee resolves to one — are both answered in this file, and a
 * second declaration of the name beside either would be a closed set written twice.
 */
const CALL_DOOR_EXPORT = "callDaemon";

/**
 * Whether `callee` names the call door, through the binding it has at `position`.
 *
 * The rule this module's header states, applied: an identifier resolving to the door's
 * own import specifier, or a member read of the door off a namespace import. Both go
 * through the scope chain the caller already built, so the answer is the one the
 * language would give at that position and a nearer binding of either name wins.
 *
 * Exported because the call-site scan beside this one asks exactly this of every callee
 * it finds; a second reading there would be the same rule in two headers, which is a
 * rule that moves in one.
 */
export function namesCallDoor(
  callee: ts.Expression,
  position: number,
  bindings: ModuleBindingScopes,
): boolean {
  if (ts.isIdentifier(callee)) {
    return isCallDoorSpecifier(bindings.resolve(callee.text, position)?.declaration);
  }
  return readsDoorOffImportedNamespace(callee, position, bindings);
}

/** Whether a declaration is the specifier that imported the door itself. */
function isCallDoorSpecifier(declaration: ts.Declaration | undefined): boolean {
  return (
    declaration !== undefined &&
    ts.isImportSpecifier(declaration) &&
    (declaration.propertyName ?? declaration.name).text === CALL_DOOR_EXPORT
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
  if (!readsMember(node, CALL_DOOR_EXPORT) || !ts.isIdentifier(node.expression)) {
    return false;
  }
  const declaration = bindings.resolve(node.expression.text, position)?.declaration;
  return declaration !== undefined && ts.isNamespaceImport(declaration);
}

/** The three ways a value is handed on rather than invoked. */
const HANDOFF_MEMBERS: readonly string[] = ["bind", "apply", "call"];

/**
 * How a module shows it reached the daemon call door, in the five shapes that reach.
 *
 *   • CALLED OR ALIASED — `daemon.call` invoked, or widened by an `as` cast or a type
 *     assertion so it can be. That is the reach: using the door, or making it usable.
 *   • NAMESPACE TAKEN — the daemon namespace bound, destructured, or spread rather than
 *     stepped through, which is how a determined evasion is spelled. Stepping THROUGH it
 *     to another member is not this: `sidekicks.daemon.subscribe(…)` names a stream, and
 *     a different gate governs streams.
 *   • The two COMPUTED KEY forms close what a dotted read cannot see:
 *     `bridge.sidekicks["daemon"].call(…)` and `daemon["call"](…)` reach the same door,
 *     and neither is exotic — a member read through a key is how a helper written over
 *     "whichever namespace this is" spells itself.
 *   • TAKEN AS A VALUE — the door handed on rather than invoked, `daemon.call.bind(…)`.
 *
 * DECIDED FROM THE ENCLOSING FORM DOWNWARD. The shared parse leaves parent pointers
 * off, so a form is recognised by matching the node that CONTAINS the door read — the
 * call, the assertion, the member read that steps through it — rather than by asking a
 * door read what encloses it. That is also why the namespace form is answered after the
 * walk: "taken" means "nothing stepped through it", which is a fact about the whole
 * file rather than about one node.
 */
export function daemonCallReaches(source: string, fileName = "probe.ts"): readonly string[] {
  const found = new Set<string>();
  const namespaceReads: ts.Node[] = [];
  const steppedThrough = new Set<ts.Node>();

  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (namesDaemonNamespaceByDots(node)) {
      namespaceReads.push(node);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      steppedThrough.add(node.expression);
    }
    if (
      (ts.isCallExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isSatisfiesExpression(node)) &&
      readsCallDoor(node.expression)
    ) {
      found.add("called or aliased");
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      HANDOFF_MEMBERS.includes(node.name.text) &&
      readsCallDoor(node.expression)
    ) {
      found.add("taken as a value");
    }
    if (ts.isElementAccessExpression(node)) {
      if (readsMember(node.expression, BRIDGE_NAMESPACE)) {
        found.add("namespace taken by computed key");
      }
      if (readsMember(node.expression, DAEMON_NAMESPACE)) {
        found.add("called by computed key");
      }
    }
  });

  if (namespaceReads.some((read) => !steppedThrough.has(read))) {
    found.add("namespace taken");
  }
  return REACH_FORM_ORDER.filter((name) => found.has(name));
}

/** The order a finding list is reported in, so a caller compares a stable list. */
const REACH_FORM_ORDER: readonly string[] = [
  "called or aliased",
  "namespace taken",
  "namespace taken by computed key",
  "called by computed key",
  "taken as a value",
];

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
export function importsCallDoor(source: string, fileName = "probe.ts"): boolean {
  const parsed = parseSourceText(fileName, source);
  return callDoorLocalNames(parsed).size > 0 || readsCallDoorThroughNamespace(parsed);
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
 */
function callDoorLocalNames(parsed: ts.SourceFile): ReadonlySet<string> {
  const localNames = new Set<string>();
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement)) {
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
type MemberRead = ts.PropertyAccessExpression | ts.ElementAccessExpression;

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
 */
function readsMember(node: ts.Node, member: string): node is MemberRead {
  return (
    readsMemberByDots(node, member) ||
    (ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === member)
  );
}

/** Whether `node` reads `<something>.<member>`, spelled with a dot. */
function readsMemberByDots(node: ts.Node, member: string): node is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(node) && node.name.text === member;
}

/** `<bridge>.sidekicks.daemon`, spelled with dots the whole way. */
function namesDaemonNamespaceByDots(node: ts.Node): boolean {
  return (
    readsMemberByDots(node, DAEMON_NAMESPACE) &&
    readsMemberByDots(node.expression, BRIDGE_NAMESPACE)
  );
}

/** Whether `node` is a read of the call door off the daemon namespace. */
function readsCallDoor(node: ts.Node): boolean {
  return readsMemberByDots(node, CALL_MEMBER) && readsMember(node.expression, DAEMON_NAMESPACE);
}
