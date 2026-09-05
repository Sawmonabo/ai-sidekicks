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
// So the instrument is source text over the shared console walk, which is what the
// timer and byte-scaling chokepoints already use for claims a selector cannot express.
// It is coarse in one direction and says so: the binding names are matched by NAME, so
// a catch binding called something this list does not carry is not read. That list is
// asserted against the tree below, so a new spelling arrives as a red gate rather than
// as a silent hole.

import { describe, expect, it } from "vitest";

import {
  consoleSourceModules,
  readConsoleSourceModule,
  type ConsoleSourceModule,
} from "../console-source-modules.js";

/**
 * The names a caught value is bound to in this tree, plus the two short spellings.
 *
 * Measured rather than assumed: `catch (error)` is what the console writes, `catch (e)`
 * is what a hurried edit writes, and `thrown` / `reason` are the two the promise tail
 * attracts. A binding outside this list is not read, which is the one direction this
 * gate is coarse in.
 */
const CAUGHT_BINDING_NAMES: readonly string[] = ["error", "e", "thrown", "reason", "rejection"];

/** How a value reaches ToPrimitive, as a source-text fragment keyed on one binding. */
interface StringificationForm {
  readonly name: string;
  /** Built per binding, because every one of these spellings names the binding. */
  readonly patternFor: (binding: string) => RegExp;
}

/**
 * The four spellings, each of which runs the SAME ToPrimitive on the same value.
 *
 * `String(x)` and `` `${x}` `` are the two explicit ones; `"" + x` is the implicit
 * concatenation; `x.toString()` calls the method the other three reach through. Nothing
 * here is exotic — each is what an engineer writes when the first is banned.
 */
const STRINGIFICATION_FORMS: readonly StringificationForm[] = [
  {
    name: "String(<caught>)",
    patternFor: (binding) => new RegExp(`\\bString\\s*\\(\\s*${binding}\\b`, "u"),
  },
  {
    name: "`${<caught>}`",
    patternFor: (binding) => new RegExp(`\\$\\{\\s*${binding}\\s*\\}`, "u"),
  },
  {
    name: '"" + <caught>',
    patternFor: (binding) => new RegExp(`(?:""|'')\\s*\\+\\s*${binding}\\b`, "u"),
  },
  {
    name: "<caught>.toString()",
    patternFor: (binding) => new RegExp(`\\b${binding}\\s*\\.\\s*toString\\s*\\(`, "u"),
  },
];

/**
 * Where a caught value is in scope: a `catch` clause, or a promise tail's callback.
 *
 * The second is the half no selector in the config reached. A `.catch((error) => …)`
 * callback holds exactly the same unestablished value, and the console's own store and
 * bridge families write their rejection tails that way.
 */
const CAUGHT_BINDING_SCOPES: readonly ((binding: string) => RegExp)[] = [
  (binding) => new RegExp(`\\bcatch\\s*\\(\\s*${binding}\\b`, "u"),
  (binding) => new RegExp(`\\.\\s*catch\\s*\\(\\s*\\(?\\s*${binding}\\b`, "u"),
];

/** Which bindings `source` catches, in either scope. */
function caughtBindings(source: string): readonly string[] {
  return CAUGHT_BINDING_NAMES.filter((binding) =>
    CAUGHT_BINDING_SCOPES.some((scope) => scope(binding).test(source)),
  );
}

/**
 * Every ToPrimitive spelling `source` applies to a value it caught, or `[]`.
 *
 * Module-scoped rather than block-scoped, and that width is deliberate: a module that
 * catches a value and stringifies something under the same name is the finding whether
 * or not the two sit in one block, and narrowing to the block would need the parser this
 * claim deliberately does not use — the question is which text a file contains.
 */
export function caughtValueStringifications(source: string): readonly string[] {
  const found: string[] = [];
  for (const binding of caughtBindings(source)) {
    for (const form of STRINGIFICATION_FORMS) {
      if (form.patternFor(binding).test(source)) {
        found.push(`${form.name} on \`${binding}\``);
      }
    }
  }
  return found;
}

describe("catch stringification — no caught value reaches ToPrimitive", () => {
  const modules: readonly ConsoleSourceModule[] = consoleSourceModules({ tests: true });

  it("finds a console tree to scan at all", () => {
    // Without this a wrong root would scan nothing and the claim below would pass over
    // the empty set — the way every source-text gate in this directory can fail green.
    expect(modules.length).toBeGreaterThan(50);
  });

  it("no console module stringifies a value it caught", () => {
    const offenders = modules
      .map((module) => ({
        module: module.displayPath,
        forms: caughtValueStringifications(readConsoleSourceModule(module)),
      }))
      .filter((entry) => entry.forms.length > 0)
      .map((entry) => `${entry.module}: ${entry.forms.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("the tree really does catch values, so the clean result is not an empty scan", () => {
    // The scope needles have to match real console source or the claim above quantifies
    // over nothing. Stated as a floor rather than a list: which modules catch is a
    // property of the tree and moves, that any do is the property this gate rests on.
    const catching = modules.filter(
      (module) => caughtBindings(readConsoleSourceModule(module)).length > 0,
    );
    expect(catching.length).toBeGreaterThan(3);
  });

  it("planted violation: every spelling the two deleted selectors missed is caught", () => {
    // Four of these five passed the selectors this gate replaces, measured through the
    // real config. Without them the clean result above would be a claim about the two
    // spellings the config could already see.
    for (const planted of [
      "try { read() } catch (error) { return String(error); }",
      "try { read() } catch (thrown) { return `${thrown}`; }",
      'try { read() } catch (error) { return "" + error; }',
      "try { read() } catch (error) { return error.toString(); }",
      "void read().catch((error) => report(String(error)));",
    ]) {
      expect(caughtValueStringifications(planted), `${planted} slipped past`).not.toStrictEqual([]);
    }
  });

  it("negative control: stringifying something else, or catching without stringifying", () => {
    // The other direction. A gate that fired on either of these would be turned off
    // within a week, which is how a chokepoint stops existing.
    expect(
      caughtValueStringifications("try { read() } catch (error) { return refuse(error); }"),
    ).toStrictEqual([]);
    expect(caughtValueStringifications("const label = String(count);")).toStrictEqual([]);
    expect(
      caughtValueStringifications("try { read() } catch (error) { return lossyStringify(error); }"),
    ).toStrictEqual([]);
    // A binding whose NAME merely starts with a caught one is not that binding.
    expect(
      caughtValueStringifications("try { read() } catch (error) { return String(errorCode); }"),
    ).toStrictEqual([]);
  });
});
