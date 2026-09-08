// How a module shows it reached PAST the daemon call door, in the five shapes that reach.
//
// A SECOND SUBJECT, SPLIT OFF ITS SIBLING. `daemon-call-census.ts` answers what the DOOR
// is — which binding a callee resolves to, and which modules consume it — and this file
// answers what a module did once it had the bridge's own `daemon` namespace in hand.
// They were one file until the door's identity grew its module half; two subjects in one
// module put that file over the length its own package rules set, and the seam they
// split on is the one the header already drew between them.
//
// THE INSTRUMENT IS THE PARSER, for the door census's reasons: `daemon.call`,
// `window.sidekicks.daemon` and `callDaemon` are things the console's own prose says
// constantly, every text needle here had been progressively narrowed to dodge comments,
// and each narrowing was a hole as well as a fix. A comment is not a node.
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
import { readsMember, readsMemberByDots } from "./daemon-call-census.js";
import { withoutTypeWrappers } from "./daemon-method-literals.js";

/** The bridge namespace whose call door is governed. */
const DAEMON_NAMESPACE = "daemon";

/** The bridge object the namespace hangs off. */
const BRIDGE_NAMESPACE = "sidekicks";

/** The door itself. */
const CALL_MEMBER = "call";

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
      steppedThrough.add(withoutTypeWrappers(node.expression));
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
      const stepped = withoutTypeWrappers(node.expression);
      if (readsMember(stepped, BRIDGE_NAMESPACE)) {
        found.add("namespace taken by computed key");
      }
      if (readsMember(stepped, DAEMON_NAMESPACE)) {
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

/** `<bridge>.sidekicks.daemon`, spelled with dots the whole way. */
function namesDaemonNamespaceByDots(node: ts.Node): boolean {
  return (
    readsMemberByDots(node, DAEMON_NAMESPACE) &&
    readsMemberByDots(withoutTypeWrappers(node.expression), BRIDGE_NAMESPACE)
  );
}

/** Whether `node` is a read of the call door off the daemon namespace. */
function readsCallDoor(node: ts.Expression): boolean {
  const read = withoutTypeWrappers(node);
  return (
    readsMemberByDots(read, CALL_MEMBER) &&
    readsMember(withoutTypeWrappers(read.expression), DAEMON_NAMESPACE)
  );
}
