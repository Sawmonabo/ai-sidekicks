// Which modules hold an announce-once latch, read out of the parse.
//
// A LATCH IS A PAIRING, not a name. `primitives/announce/reading-announcement.ts` states the
// rule the console announces by — say a sentence when it is new, stay silent when it
// is not, and remember what was said in a ref so remembering never causes a render —
// and the shape that rule takes is always the same two things inside one `useEffect`:
// a call to the binding `useAnnounce()` produced, and a read or a write of a ref's
// `.current`. Neither half alone is one. A surface that announces from a `useCallback`
// is speaking for an act a person just performed and remembers nothing; a component
// that holds a ref in an effect for a measurement is remembering something nobody
// hears. The defect this reading is for is the pair, because the pair is a second copy
// of a comparison, and the place two copies of a latch drift is the comparison — a
// drifted comparison is a sentence a person hears twice with every test still green.
//
// READ OUT OF THE PARSE RATHER THAN OUT OF THE TEXT, for the reason the source-walk
// census next door gives for its own predicates: a needle over source text fires on
// the header sentence above, which names both halves, and misses `const speak =
// useAnnounce()` followed by `speak(...)`, which carries no `announce(` anywhere. The
// binding is therefore taken from the DECLARATION that produced it, so whatever a
// module named its announcer is the name this reading looks for.
//
// THE LIMIT IS NAMED RATHER THAN HIDDEN: an announcer reached as a member expression
// — held on an object, on a class field — is not read as a call to the binding, and no
// module in this tree holds one that way. A module that starts to would be reported by
// nothing here, which is why the gate beside this file asserts a floor on what the
// reading found rather than only on what it did not find.

import ts from "typescript";

import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** The hook a module calls to obtain the window's announcer. */
const ANNOUNCER_HOOK = "useAnnounce";

/** The hook whose callback a latch's comparison and announcement both live inside. */
const EFFECT_HOOK = "useEffect";

/** The ref property a latch reads its memory of the last pass through. */
const LATCH_MEMORY_PROPERTY = "current";

/** One module this reading is asked about, named the way a failure names it. */
export interface AnnounceLatchModuleText {
  /** What a failure message names the module by. */
  readonly displayPath: string;
  readonly source: string;
}

/** Whether `node` is a call to the function named `functionName`. */
function isCallTo(node: ts.Node, functionName: string): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === functionName
  );
}

/**
 * Every identifier this module bound to the window's announcer.
 *
 * Taken from `const <name> = useAnnounce()` wherever it appears, including inside a
 * hook the module declares for itself — which is exactly where a copied latch puts it.
 */
function announcerBindingsIn(parsed: ts.SourceFile): ReadonlySet<string> {
  const bindings = new Set<string>();
  forEachDescendant(parsed, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isCallTo(node.initializer, ANNOUNCER_HOOK)
    ) {
      bindings.add(node.name.text);
    }
  });
  return bindings;
}

/** Whether `effectBody` both speaks through `announcers` and consults a ref's memory. */
function isLatchBody(effectBody: ts.Node, announcers: ReadonlySet<string>): boolean {
  let speaks = false;
  let remembers = false;
  forEachDescendant(effectBody, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      announcers.has(node.expression.text)
    ) {
      speaks = true;
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === LATCH_MEMORY_PROPERTY) {
      remembers = true;
    }
  });
  return speaks && remembers;
}

/** Whether this module declares an announce-once latch of its own. */
export function declaresAnnounceLatch(module: AnnounceLatchModuleText): boolean {
  const parsed = parseSourceText(module.displayPath, module.source);
  const announcers = announcerBindingsIn(parsed);
  if (announcers.size === 0) {
    return false;
  }
  let found = false;
  forEachDescendant(parsed, (node) => {
    if (found || !isCallTo(node, EFFECT_HOOK)) {
      return;
    }
    const effectBody = node.arguments[0];
    if (effectBody !== undefined && isLatchBody(effectBody, announcers)) {
      found = true;
    }
  });
  return found;
}

/** Every module in `modules` that declares a latch, by display path, in scan order. */
export function announceLatchModules(
  modules: readonly AnnounceLatchModuleText[],
): readonly string[] {
  return modules.filter(declaresAnnounceLatch).map((module) => module.displayPath);
}
