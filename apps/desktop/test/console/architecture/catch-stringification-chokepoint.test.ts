// A caught value is never handed to ToPrimitive, in any of the spellings that do it.
//
// WHY THIS FILE EXISTS AND WHY IT IS NOT A LINT RULE. `String(error)` inside a `catch`
// runs ToPrimitive on a value nobody has established anything about: it throws on a
// null-prototype value carrying no `toString`, and on any hostile accessor — inside the
// expression that exists to report a failure, and after the `catch` has been left. The
// console's answer is `lossyStringify` from `src/shared/wire-errors.ts`, which is total.
//
// Two selectors in `apps/desktop/eslint.config.mjs` used to make this claim and reached
// four of eight spellings. The template-literal arm was keyed on the two catch binding
// NAMES the tree happens to use (`e`, `error`), so a third name reached neither arm;
// `"" + error` and `error.toString()` run the same ToPrimitive and were named in no
// selector; and `.catch((error) => …)` is not a `CatchClause`, so every promise-tail
// form was outside all of them. esquery has no backreferences, so no selector can bind
// a catch parameter and compare it to the identifier being stringified — the arm that
// tried was the name-keyed approximation, and a rule that catches half a class reads
// exactly like one that catches the class.
//
// WHY IT IS NO LONGER A NAME CENSUS EITHER. The first answer here was source text over
// a hand-listed set of five binding names, which is the same approximation one layer
// down: it read the whole module rather than the clause, and it read only the bindings
// somebody had thought of. Measured against the tree — 388 console modules, tests
// included — there are 21 caught bindings under 11 distinct names, and the five-name
// census named two of them: it reached 10 bindings and read none of the other 11, whose
// names run to `constructionFailure`, `tripwireFailure`, and `sinkFailure`. Its own
// non-vacuity check asked for more than three CATCHING MODULES, a bar those five names
// cleared by themselves, so the hole was invisible from inside the gate.
//
// So the instrument is the PARSER, which is what a question about a binding's scope
// needs: `ts.CatchClause` yields the binding this clause declares whatever it is called,
// and the search for a stringification runs over that clause's own block rather than
// over the file. Both halves matter. Without the first, a binding named `problem` is not
// read at all; without the second, a module that catches a value and stringifies an
// unrelated variable of the same name elsewhere is a false positive the next reader
// deletes the gate over.
//
// THREE SHAPES BIND A CAUGHT VALUE, and two of them are promise tails no `CatchClause`
// selector reaches. `.catch((error) => …)` holds exactly the same unestablished value,
// and so does the SECOND argument of `.then(onFulfilled, onRejected)` — the same
// handler written on the settled call rather than after it. Reading only the `.catch`
// spelling left that arm open, and the console had a live instance of it: a rejection
// handler passed to `then` stringified a load failure while this gate reported clean.
// All three are found here, and each is searched over the body its binding is in scope
// across — a closure the handler creates included, since the value escapes into it
// unchanged.
//
// A `.finally` TAIL NEEDS NO ARM OF ITS OWN. Its callback takes no parameter, so it
// binds nothing; a `promise.then(a, b).finally(c)` chain is covered because the `then`
// call is its own node in the tree and is visited whatever is chained after it.
//
// WHAT IT STILL DOES NOT READ, stated rather than left to be discovered: a destructured
// binding (`catch ({ message })`) declares no identifier to compare against, so a clause
// written that way contributes nothing. It is also already past the hazard — reading
// `message` off an unestablished value is the throw this gate is about, one step earlier
// — and a gate that reported it would be reporting a different rule than the one it
// states. `syntax-ban-cases.test.ts` is where a destructuring ban would go.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  consoleSourceModules,
  readConsoleSourceModule,
  type ConsoleSourceModule,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** One caught value: what it is called, and the code it is in scope across. */
interface CaughtBinding {
  readonly name: string;
  /** The clause's block, or the promise tail's callback body. */
  readonly scope: ts.Node;
  /** How the value was caught, for a failure message that says which shape. */
  readonly shape: "catch clause" | "promise tail" | "then rejection handler";
}

/**
 * The two promise tails that bind a rejection, and which argument each binds it in.
 *
 * A TABLE RATHER THAN A SECOND BRANCH, because the difference between the two spellings
 * is one index and nothing else: `.catch(onRejected)` and `.then(onFulfilled,
 * onRejected)` hand the identical unestablished value to the identical kind of
 * callback. Written as two branches the second was simply never written, which is how
 * the `then` form stayed unread by a gate whose whole subject it is.
 */
const REJECTION_TAILS: readonly {
  readonly method: string;
  readonly argumentIndex: number;
  readonly shape: CaughtBinding["shape"];
}[] = [
  { method: "catch", argumentIndex: 0, shape: "promise tail" },
  { method: "then", argumentIndex: 1, shape: "then rejection handler" },
];

/** The global whose call runs ToPrimitive. Compared exactly, so `lossyStringify` is not it. */
const STRINGIFY_GLOBAL = "String";

/** The method every other spelling reaches through. */
const TO_STRING_METHOD = "toString";

/** The first parameter of `callee`, when it is a function taking a plain identifier. */
function callbackBinding(callee: ts.Node): { name: string; body: ts.Node } | undefined {
  if (!ts.isArrowFunction(callee) && !ts.isFunctionExpression(callee)) {
    return undefined;
  }
  const [parameter] = callee.parameters;
  if (parameter === undefined || !ts.isIdentifier(parameter.name)) {
    return undefined;
  }
  return { name: parameter.name.text, body: callee.body };
}

/** The caught value `node` binds, if it binds one. */
function caughtBindingAt(node: ts.Node): CaughtBinding | undefined {
  if (ts.isCatchClause(node)) {
    const declared = node.variableDeclaration?.name;
    if (declared === undefined || !ts.isIdentifier(declared)) {
      // A destructured or absent binding. See this module's header.
      return undefined;
    }
    return { name: declared.text, scope: node.block, shape: "catch clause" };
  }
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return undefined;
  }
  const called = node.expression.name.text;
  const tail = REJECTION_TAILS.find((candidate) => candidate.method === called);
  if (tail === undefined) {
    return undefined;
  }
  // A `then` with one argument has no rejection handler at all, which the index read
  // answers with `undefined` rather than with a branch of its own.
  const callee = node.arguments[tail.argumentIndex];
  const bound = callee === undefined ? undefined : callbackBinding(callee);
  return bound === undefined
    ? undefined
    : { name: bound.name, scope: bound.body, shape: tail.shape };
}

/** Every caught value `parsed` binds, in source order. */
export function caughtBindings(parsed: ts.SourceFile): readonly CaughtBinding[] {
  const found: CaughtBinding[] = [];
  forEachDescendant(parsed, (node) => {
    const caught = caughtBindingAt(node);
    if (caught !== undefined) {
      found.push(caught);
    }
  });
  return found;
}

/** Whether `node` is the caught binding itself, rather than something read off it. */
function isCaughtValue(node: ts.Node, binding: string): boolean {
  return ts.isIdentifier(node) && node.text === binding;
}

/** Whether `node` is a string the caught value could be concatenated onto. */
function isStringOperand(node: ts.Node): boolean {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/**
 * How a value reaches ToPrimitive. Four spellings, one hazard.
 *
 * `String(x)` and `` `${x}` `` are the two explicit ones; `"" + x` is the implicit
 * concatenation, and it is matched against ANY string operand rather than the empty one
 * alone, because `"read failed: " + error` runs the identical conversion; `x.toString()`
 * calls the method the other three reach through. Nothing here is exotic — each is what
 * an engineer writes when the first is banned.
 */
function stringificationAt(node: ts.Node, binding: string): string | undefined {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === STRINGIFY_GLOBAL &&
    node.arguments.length === 1 &&
    node.arguments[0] !== undefined &&
    isCaughtValue(node.arguments[0], binding)
  ) {
    return `String(${binding})`;
  }
  if (ts.isTemplateSpan(node) && isCaughtValue(node.expression, binding)) {
    return `\`\${${binding}}\``;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    ((isStringOperand(node.left) && isCaughtValue(node.right, binding)) ||
      (isCaughtValue(node.left, binding) && isStringOperand(node.right)))
  ) {
    return `"…" + ${binding}`;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === TO_STRING_METHOD &&
    isCaughtValue(node.expression.expression, binding)
  ) {
    return `${binding}.toString()`;
  }
  return undefined;
}

/**
 * Every ToPrimitive spelling `source` applies to a value it caught, or `[]`.
 *
 * Scoped to the clause rather than to the module, which is the whole reason this reads
 * an AST: a module that catches `error` in one function and formats an unrelated
 * `error` in another is not the finding, and a gate that said it was would be deleted
 * the first week somebody hit it.
 */
export function caughtValueStringifications(fileName: string, source: string): readonly string[] {
  const parsed = parseSourceText(fileName, source);
  const found: string[] = [];
  for (const binding of caughtBindings(parsed)) {
    const consider = (node: ts.Node): void => {
      const spelling = stringificationAt(node, binding.name);
      if (spelling !== undefined) {
        found.push(`${spelling} in a ${binding.shape}`);
      }
    };
    consider(binding.scope);
    forEachDescendant(binding.scope, consider);
  }
  return found;
}

describe("catch stringification — no caught value reaches ToPrimitive", () => {
  const modules: readonly ConsoleSourceModule[] = consoleSourceModules({ tests: true });
  const bindingsByModule = modules.map((module) => ({
    module: module.displayPath,
    source: readConsoleSourceModule(module),
  }));
  // Parsed once for the whole file. Every case below is a comparison over this reading,
  // for the reason `console-layering-rules.test.ts` records about its cruises: a walk of
  // ~390 modules charged to a case runs against vitest's default timeout under aggregate
  // tier load, and two cases asking for it separately pay for it twice.
  const everyCaughtBinding = bindingsByModule.flatMap((entry) =>
    caughtBindings(parseSourceText(entry.module, entry.source)),
  );

  it("finds a console tree to scan at all", () => {
    // Without this a wrong root would scan nothing and the claim below would pass over
    // the empty set — the way every source-text gate in this directory can fail green.
    expect(modules.length).toBeGreaterThan(50);
  });

  it("no console module stringifies a value it caught", () => {
    const offenders = bindingsByModule
      .map((entry) => ({
        module: entry.module,
        forms: caughtValueStringifications(entry.module, entry.source),
      }))
      .filter((entry) => entry.forms.length > 0)
      .map((entry) => `${entry.module}: ${entry.forms.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("reads far more caught bindings than the name census it replaced", () => {
    // The scope search has to find real bindings or the claim above quantifies over
    // nothing, and the floor is set where it says something: the five hand-listed names
    // this gate used to carry reached 10 bindings, and its own non-vacuity check asked
    // for more than three catching MODULES — a bar those five cleared alone, which is
    // why the hole was invisible from inside. A floor rather than the measured 21,
    // because which modules catch is a property of the tree and moves; above 10,
    // because below it this gate would be no better than the census it replaced.
    expect(everyCaughtBinding.length).toBeGreaterThan(12);
    // And the shape no `CatchClause` selector could ever have reached.
    expect(everyCaughtBinding.some((binding) => binding.shape === "promise tail")).toBe(true);
  });

  it("negative control: it reads bindings the five-name census could not", () => {
    // The direct proof that the instrument changed rather than the wording. Without it
    // the floor above could be met entirely by bindings the old list already named, and
    // this gate would have been rewritten to say the same thing more slowly.
    const supersededCensus = ["error", "e", "thrown", "reason", "rejection"];
    const beyondCensus = everyCaughtBinding.filter(
      (binding) => !supersededCensus.includes(binding.name),
    );
    expect(beyondCensus.length).toBeGreaterThan(0);
    expect(new Set(beyondCensus.map((binding) => binding.name)).size).toBeGreaterThan(3);
  });

  it("planted violation: every spelling reaches the same ToPrimitive", () => {
    // Four of these six passed the two selectors this gate first replaced, measured
    // through the real config; the last two passed the name census that replaced them.
    for (const planted of [
      "try { read() } catch (error) { return String(error); }",
      "try { read() } catch (thrown) { return `${thrown}`; }",
      'try { read() } catch (error) { return "" + error; }',
      'try { read() } catch (error) { return "read failed: " + error; }',
      "try { read() } catch (error) { return error.toString(); }",
      "void read().catch((error) => report(String(error)));",
      // The `then` rejection handler — the same value, one argument over, and the arm
      // this gate could not read until the tails became a table. The console had a live
      // instance of exactly this shape while the suite reported clean.
      "void read().then(onLoaded, (loadError) => report(String(loadError)));",
      // Chained, because a `finally` after it needs no arm of its own: the `then` call
      // is its own node whatever follows it.
      "void read().then(onLoaded, (loadError) => report(`${loadError}`)).finally(done);",
      // The name census read five names and this is none of them.
      "try { read() } catch (whateverWentWrong) { return String(whateverWentWrong); }",
      // The value escapes into a closure the clause creates, unchanged.
      "try { read() } catch (error) { queue(() => report(`${error}`)); }",
    ]) {
      expect(
        caughtValueStringifications("planted.ts", planted),
        `${planted} slipped past`,
      ).not.toStrictEqual([]);
    }
  });

  it("negative control: stringifying something else, or catching without stringifying", () => {
    // The other direction. A gate that fired on any of these would be turned off within
    // a week, which is how a chokepoint stops existing.
    for (const clean of [
      "try { read() } catch (error) { return refuse(error); }",
      "const label = String(count);",
      // The total stringifier is the answer this gate exists to route callers to, and
      // it is a different callee — compared by name rather than by a word boundary.
      "try { read() } catch (error) { return lossyStringify(error); }",
      "try { read() } catch (error) { return `${lossyStringify(error)}`; }",
      // A binding whose NAME merely starts with a caught one is not that binding.
      "try { read() } catch (error) { return String(errorCode); }",
      // The class the module-wide census could not separate: one function catches and
      // another formats an unrelated value of the same name.
      "function read() { try { open() } catch (error) { refuse(error) } }\nfunction label(error: string) { return String(error); }",
      // A member read off the value is a different hazard and a different rule.
      "try { read() } catch (error) { return String(error.message); }",
      // A `then` with ONE argument binds no rejection at all, so its parameter is a
      // settled value and stringifying it is not this gate's subject. Without this the
      // widening would report every `.then((value) => `${value}`)` in the console.
      "void read().then((value) => report(String(value)));",
      // And the fulfilled handler of a two-argument `then` is still that settled value.
      "void read().then((value) => report(String(value)), refuse);",
    ]) {
      expect(
        caughtValueStringifications("planted.ts", clean),
        `${clean} was reported`,
      ).toStrictEqual([]);
    }
  });
});
