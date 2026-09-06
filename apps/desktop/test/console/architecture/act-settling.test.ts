// A settle is a boundary, never a count of microtasks.
//
// THE DEFECT THIS FORBIDS. `await act(async () => { await Promise.resolve(); })`, and
// the same line written two, three, or four times over. The number is tuned against
// whatever promise chain the case happened to be written over: a reply that grows one
// link deeper stops being waited for, and the case then reports the ABSENCE of an
// answer that was merely still in flight. A presence claim fails loudly when that
// happens and an absence claim goes quietly green, so the failure mode is silent in
// exactly the direction that matters.
//
// `fixture-bridge.test-support.ts` states the replacement and why it is a different
// KIND of wait: `drainMicrotasks` resolves on a macrotask boundary, so every pending
// microtask chain has run whatever its depth. The fix wave adopted it in eighteen
// files and left ninety-one counted awaits standing in twenty-two others, which is
// why this is a gate — a fifth settle vocabulary is never written deliberately, it is
// written by an author who did not know the fourth existed.
//
// SCOPED TO AN `act` BODY, and that is the whole precision of the claim. A bare
// `await Promise.resolve()` elsewhere is an ordinary microtask yield — a scheduler
// test asserting that nothing has been performed yet, a helper handing control back —
// and forbidding it would forbid the thing rather than the misuse. Inside an `act`
// body the same line is a claim that React has finished, which it is not.
//
// TESTS ARE THE SUBJECT, so the walk includes them — AND SO ARE THE ROOTS THEY LIVE
// UNDER. `{ tests: true }` widens the FILE filter and not the root list, and this gate
// shipped taking the default roots, `console/` + `shell/`, which reach no file under
// `apps/desktop/test/`. The two largest homes of the defect were therefore outside the
// walk: the single settle every browser-tier mount goes through, and the family
// surface module both pinned tiers mount — each running the exact counted pair this
// header forbids, and each green. `DESKTOP_PROSE_ROOTS` is the package-wide root list
// that already existed for this widening, and the floor case below asserts the walk
// reached the added root rather than trusting that it did.

import { describe, expect, it } from "vitest";
import ts from "typescript";

import {
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
  DESKTOP_PROSE_ROOTS,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** The settle a case must reach for instead. Named so a failure can say it. */
const BOUNDARY_HELPER = "drainMicrotasks";

/**
 * Whether this call expression is `Promise.resolve()` with no argument.
 *
 * The no-argument form only: `Promise.resolve(value)` inside an `act` body is a
 * caller building a settled promise to hand to something, which is not a settle at
 * all and is not this gate's business.
 */
function isBareResolvedPromise(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    node.arguments.length === 0 &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Promise" &&
    node.expression.name.text === "resolve"
  );
}

/** Whether this call is `act(...)`, under either the bare or `await`ed spelling. */
function isActCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "act"
  );
}

/**
 * The one-based lines inside an `act` body that await a bare resolved promise.
 *
 * A pure function over text, so the negative controls below drive it with sources
 * whose verdict is known and the checker is proved to bite without perturbing a real
 * module.
 */
function countedSettleLines(fileName: string, sourceText: string): readonly number[] {
  const source = parseSourceText(fileName, sourceText);
  const lines: number[] = [];
  forEachDescendant(source, (node) => {
    if (!isActCall(node)) {
      return;
    }
    for (const argument of node.arguments) {
      forEachDescendant(argument, (inner) => {
        if (ts.isAwaitExpression(inner) && isBareResolvedPromise(inner.expression)) {
          lines.push(source.getLineAndCharacterOfPosition(inner.getStart(source)).line + 1);
        }
      });
    }
  });
  return lines;
}

describe("act-settling — a settle is a boundary, never a count", () => {
  // Tests included, because they are what this rule is about, and the package-wide
  // roots because the tier harnesses they run through are tests too.
  const modules = consoleSourceModules({ roots: DESKTOP_PROSE_ROOTS, tests: true });
  const displayPaths = modules.map((module) => module.displayPath);

  it("reaches every root a suite waits in, not the console alone", () => {
    // Without this a wrong root would scan nothing and the assertion below would pass
    // over the empty set — and, since this gate shipped scoped to the console once
    // already, the added root is named rather than left to a count that a large
    // console alone would satisfy. `test/console/` is where both offenders that
    // prompted the widening live; the co-located classes are named for the reason
    // `one-doc-per-declaration.test.ts` names its own — each is a separate way for
    // the walk to narrow back with nothing reporting the difference.
    expect(displayPaths.length).toBeGreaterThan(400);
    expect(displayPaths).toContain("test/console/console-harness.tsx");
    expect(displayPaths).toContain("src/renderer/src/console/frame/ConsoleRoot.tsx");
    expect(displayPaths.filter((path) => path.endsWith(".test.tsx"))).not.toStrictEqual([]);
    expect(displayPaths.filter((path) => path.includes(".test-support."))).not.toStrictEqual([]);
  });

  it("no act body waits on a counted microtask", () => {
    const offenders = modules
      .map((module) => ({
        module: module.displayPath,
        lines: countedSettleLines(module.displayPath, readConsoleSourceModule(module)),
      }))
      .filter((entry) => entry.lines.length > 0)
      .map((entry) => `${entry.module}: line(s) ${entry.lines.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("planted control: the shape is caught in the root this gate had not been reaching", () => {
    // The widening proved rather than asserted. The two offenders that prompted it
    // both sat under `test/`, so the plant is made in a module found THERE — its own
    // real text, with the forbidden pair spliced into its real settle — and the
    // checker is asked about the result. A walk that stopped at the console roots
    // would not have this module's text to plant into, and `moduleNamed` would throw
    // before the assertion rather than passing over an empty set.
    const harness = moduleNamed(
      modules,
      "test/console/console-harness.tsx",
      "the settle every browser-tier mount goes through",
    );
    const clean = readConsoleSourceModule(harness);
    expect(countedSettleLines(harness.displayPath, clean)).toStrictEqual([]);
    const planted = clean.replace(
      "    await drainMicrotasks();",
      "    await Promise.resolve();\n    await Promise.resolve();",
    );
    expect(planted).not.toBe(clean);
    expect(countedSettleLines(harness.displayPath, planted)).toHaveLength(2);
  });

  it("negative control: the checker bites on the shape it forbids", () => {
    // Without this a typo in the walk would make the clean result above meaningless.
    const counted = [
      "await act(async () => {",
      "  await Promise.resolve();",
      "  await Promise.resolve();",
      "});",
    ].join("\n");
    expect(countedSettleLines("counted.test.ts", counted)).toStrictEqual([2, 3]);
  });

  it("negative control: the boundary settle and a bare yield outside act are allowed", () => {
    // The two sides of the line the header draws. A microtask yield that is not a
    // claim about React is not this gate's business, and the replacement must not
    // trip the rule it exists to satisfy.
    const boundary = ["await act(async () => {", `  await ${BOUNDARY_HELPER}();`, "});"].join("\n");
    expect(countedSettleLines("boundary.test.ts", boundary)).toStrictEqual([]);
    expect(countedSettleLines("yield.test.ts", "await Promise.resolve();")).toStrictEqual([]);
    // And an argument is a promise being BUILT, not a settle being awaited.
    const built = ["await act(async () => {", "  await Promise.resolve(reply);", "});"].join("\n");
    expect(countedSettleLines("built.test.ts", built)).toStrictEqual([]);
  });
});
