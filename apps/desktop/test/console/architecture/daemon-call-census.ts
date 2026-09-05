// The reach census the daemon-reply chokepoint next door runs: how a module shows it
// reached the bridge's call door, and how it shows it consumes it.
//
// A MODEL BESIDE ITS GATE, on the `barrel-census.ts` pattern. The gate reads the real
// console while its controls drive needles with sources written by hand to fail, and the
// two jobs had grown into one 433-line file. The needles take source text as a
// parameter; the walk that produces the real modules stays in the gate.
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

import ts from "typescript";

import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** The bridge namespace whose call door is governed. */
const DAEMON_NAMESPACE = "daemon";

/** The bridge object the namespace hangs off. */
const BRIDGE_NAMESPACE = "sidekicks";

/** The door itself. */
const CALL_MEMBER = "call";

/** The door's consumer-facing name, as `bridge/index.ts` publishes it. */
const CALL_DOOR_EXPORT = "callDaemon";

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
      if (namesDaemonNamespace(node.expression)) {
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
 * Whether `source` CONSUMES the call door: it imports the door's own name.
 *
 * Read off the import clause, which is what the regular expression this replaces spent
 * two narrowings approximating. `\bimport\b[^;]*\bcallDaemon\b` spanned newlines, so a
 * comment reading "a surface would import `callDaemon` from the bridge door" matched
 * it; requiring a brace between the two words fixed that one case and still matched a
 * comment that happened to contain one. An import clause is a node, and a comment is
 * not.
 *
 * A NAMESPACE import is deliberately not counted, on the reasoning the walk chokepoint
 * takes for the same shape: `import * as bridge` names no specifier this scan can
 * enumerate, and reporting it as a consumer would attribute the door to every module
 * that imports the family for anything at all.
 */
export function importsCallDoor(source: string, fileName = "probe.ts"): boolean {
  for (const statement of parseSourceText(fileName, source).statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || ts.isNamespaceImport(bindings)) {
      continue;
    }
    if (
      bindings.elements.some(
        (element) => (element.propertyName ?? element.name).text === CALL_DOOR_EXPORT,
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Whether `node` reads `<something>.<member>`. */
function readsMember(node: ts.Node, member: string): node is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(node) && node.name.text === member;
}

/** `<bridge>.sidekicks.daemon`, spelled with dots the whole way. */
function namesDaemonNamespaceByDots(node: ts.Node): boolean {
  return readsMember(node, DAEMON_NAMESPACE) && readsMember(node.expression, BRIDGE_NAMESPACE);
}

/** The daemon namespace, however the last step was spelled. */
function namesDaemonNamespace(node: ts.Expression): boolean {
  return (
    readsMember(node, DAEMON_NAMESPACE) ||
    (ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === DAEMON_NAMESPACE)
  );
}

/** Whether `node` is a read of the call door off the daemon namespace. */
function readsCallDoor(node: ts.Node): boolean {
  return readsMember(node, CALL_MEMBER) && namesDaemonNamespace(node.expression);
}
