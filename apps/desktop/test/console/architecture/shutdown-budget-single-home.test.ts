// One shutdown budget, declared once, read by both processes.
//
// The restart confirmation told a person the daemon is given up to ten seconds to
// finish writing. The quit path raced `PtyHost.shutdown()` against five. Both figures
// were named, rationale-carrying declarations — `DAEMON_SHUTDOWN_FLUSH_BUDGET_MS` in
// the console's cap home and `HARD_QUIT_CAP_MS` in `src/main/sidecar-lifecycle.ts`
// — and neither could see the other, because main imports nothing from the renderer and
// the renderer imports nothing from main. So the disagreement was structurally
// unobservable from either side, and what it produced was not a wrong number on a screen
// but a promise the shell did not keep: the daemon was stopped with half the budget a
// person had just been shown, and a flush that needed the second half lost it silently.
//
// WHY THE NAME CENSUS IS NOT ENOUGH ON ITS OWN, and why this file carries three halves
// rather than one. `bootstrap-channel-name-single-home.test.ts` can scan for a spelling
// because the copy it forbids is a copy of a STRING — the second declaration wore the
// same word. Here the second declaration wore a different name and a different value,
// which is exactly what let it live: nothing about `HARD_QUIT_CAP_MS = 5_000` looks like
// a copy of `DAEMON_SHUTDOWN_FLUSH_BUDGET_MS = 10_000`. So the census asks a question
// about ROLE rather than about spelling — does this name say it bounds a shutdown wait —
// and two further halves close what a role census leaves open: that the consumers
// actually take the binding, and that main's default is the binding rather than a
// literal, since `deps.hardCapMs ?? 5_000` re-introduces the whole defect while
// declaring no name at all.
//
// NAMES AND ONE INITIALIZER, NOT VALUES. `cap-single-home.test.ts` says "Names, not
// values, and that line is deliberate," and this file holds that line everywhere except
// the one place a name is absent by construction: the `??` default, where the thing to
// read IS the initializer. Nothing here asserts that the budget is ten seconds. What
// governs the value is `Spec-023 §Main Process Responsibilities`, and a test asserting a
// figure the spec fixes would be a fourth home for it.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  DESKTOP_SOURCE_ROOT,
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";
import { readModuleSyntax } from "./barrel-syntax.js";

/** The one module allowed to declare the budget, and the name it declares it under. */
const BUDGET_HOME = "src/shared/shutdown-budget.ts";

/** The console's cap home, whose modules the census below has to reach. */
const CONSOLE_CAP_HOME = "src/renderer/src/console/core/constants/";
const BUDGET_BINDING = "DAEMON_SHUTDOWN_FLUSH_BUDGET_MS";

/**
 * The two vocabularies a shutdown-wait bound is spelled from, and it needs one of each.
 *
 * Separate tuples intersected rather than one list of full names, because the defect was
 * a name nobody would have thought to list: the second home was called `HARD_QUIT_CAP_MS`
 * and a roster of forbidden identifiers would have been written after reading the file
 * that already had it. What both halves together say is "this name claims to bound the
 * shutdown wait" — `QUIT` + `CAP`, `SHUTDOWN` + `BUDGET`, `DRAIN` + `TIMEOUT` — and a
 * name carrying only one half is bounding something else or naming something unbounded.
 *
 * `MS` is a bound word HERE and is deliberately not one in `bound-words.ts`: that census
 * asks whether a name is a cap at all, where a duration suffix separates nothing, while
 * this one has already established the subject from the first tuple and only needs to
 * know that the name states a quantity.
 */
const SHUTDOWN_WAIT_WORDS: readonly string[] = ["SHUTDOWN", "QUIT", "DRAIN"];
const BOUND_QUANTITY_WORDS: readonly string[] = ["BUDGET", "CAP", "TIMEOUT", "DEADLINE", "MS"];

/**
 * Whether one binding name declares a bound on the shutdown wait.
 *
 * SCREAMING_CASE is required for the reason `cap-single-home.test.ts` requires it: a
 * `hardCapMs` parameter carries the letters and declares nothing — it is the injection
 * seam the tests drive, and forbidding it would forbid testing the cap branch at all.
 */
function isShutdownWaitBoundName(name: string): boolean {
  if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) {
    return false;
  }
  const tokens = name.split("_");
  return (
    tokens.some((token) => SHUTDOWN_WAIT_WORDS.includes(token)) &&
    tokens.some((token) => BOUND_QUANTITY_WORDS.includes(token))
  );
}

/** The numeric literal a declaration binds, through an `as const` where one is written. */
function numericLiteralOf(initializer: ts.Expression | undefined): ts.NumericLiteral | undefined {
  if (initializer === undefined) {
    return undefined;
  }
  const inner = ts.isAsExpression(initializer) ? initializer.expression : initializer;
  return ts.isNumericLiteral(inner) ? inner : undefined;
}

/**
 * Every shutdown-wait bound `source` DECLARES, as `name` entries.
 *
 * A pure function over text so the controls below can drive it with bodies whose verdict
 * is known, rather than planting a second home in the tree to prove the gate bites.
 */
function declaredShutdownWaitBounds(fileName: string, source: string): readonly string[] {
  const declared: string[] = [];
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isShutdownWaitBoundName(node.name.text) &&
      numericLiteralOf(node.initializer) !== undefined
    ) {
      declared.push(node.name.text);
    }
  });
  return declared;
}

/**
 * What `src/main/sidecar-lifecycle.ts` falls back to when no test injects a cap.
 *
 * Answered from the parse as either the identifier on the right of the `??` or the text
 * of whatever stands there instead, because the two failures this half exists for are
 * both spelled in that one position: a literal written back in, and a second constant
 * introduced beside the shared one.
 */
function hardCapDefaultOf(source: string): string {
  const sourceFile = parseSourceText("sidecar-lifecycle.ts", source);
  let found: string | undefined;
  // A descendant walk and not a statement loop: the default is resolved inside
  // `registerSidecarLifecycle`, so a scan of the module's top level finds nothing and
  // reports that as an answer.
  forEachDescendant(sourceFile, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      node.name.text !== "hardCapMs"
    ) {
      return;
    }
    const { initializer } = node;
    if (
      initializer === undefined ||
      !ts.isBinaryExpression(initializer) ||
      initializer.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
    ) {
      found = "<not a ?? default>";
      return;
    }
    found = ts.isIdentifier(initializer.right)
      ? initializer.right.text
      : initializer.right.getText(sourceFile);
  });
  return found ?? "<no hardCapMs declaration>";
}

/** Whether `source` takes `BUDGET_BINDING` from `specifier`, and with which disposition. */
function reachFor(
  fileName: string,
  source: string,
  specifier: string,
): { readonly takes: boolean; readonly forwarded: boolean } {
  const [syntax] = readModuleSyntax([{ path: fileName, source, isTest: false }]);
  if (syntax === undefined) {
    // The reader answers one entry per module handed to it, so this is unreachable —
    // and saying so is what keeps a future reader that filtered its input from turning
    // every case below into a silent `false`.
    throw new Error(`the module reader returned nothing for ${fileName}`);
  }
  const reach = syntax.reaches.find(
    (candidate) =>
      candidate.moduleSpecifier === specifier &&
      candidate.names !== "namespace" &&
      candidate.names.includes(BUDGET_BINDING),
  );
  return { takes: reach !== undefined, forwarded: reach?.forwarded ?? false };
}

describe("the daemon shutdown budget — one declaration, both processes", () => {
  const modules = consoleSourceModules({ roots: [DESKTOP_SOURCE_ROOT] });

  it("finds both processes' source to scan at all", () => {
    // Without this a wrong root would scan nothing and the census below would pass over
    // the empty set — and the whole point of this gate is that it reaches `src/main/`,
    // which every console-scoped gate in this tier deliberately does not.
    const paths = modules.map((module) => module.displayPath);
    expect(paths).toContain("src/main/sidecar-lifecycle.ts");
    expect(paths).toContain(BUDGET_HOME);
    // And the console's cap home, which is a DIRECTORY of one module per concern: the
    // census below has to reach every one of them, because the second declaration this
    // gate exists for would be written wherever a hand thought a duration belonged.
    expect(paths.filter((path) => path.startsWith(CONSOLE_CAP_HOME)).length).toBeGreaterThan(1);
  });

  it("is declared in exactly one module", () => {
    const homes = modules
      .flatMap((module) =>
        declaredShutdownWaitBounds(module.displayPath, readConsoleSourceModule(module)).map(
          (name) => `${module.displayPath}: ${name}`,
        ),
      )
      .sort();
    expect(homes).toStrictEqual([`${BUDGET_HOME}: ${BUDGET_BINDING}`]);
  });

  it("is what main falls back to when no cap is injected", () => {
    // The half a declaration census cannot make: deleting the second constant and
    // writing `deps.hardCapMs ?? 5_000` in its place declares no name, passes the
    // census, and restores the defect exactly.
    const source = readConsoleSourceModule(moduleNamed(modules, "src/main/sidecar-lifecycle.ts"));
    expect(hardCapDefaultOf(source)).toBe(BUDGET_BINDING);
    expect(
      reachFor("src/main/sidecar-lifecycle.ts", source, "../shared/shutdown-budget.js"),
    ).toStrictEqual({ takes: true, forwarded: false });
  });

  it("reaches the console through the floor's door and no other way", () => {
    const doorPath = "src/renderer/src/console/core/index.ts";
    const door = readConsoleSourceModule(moduleNamed(modules, doorPath));
    // The door MOVES it — `console-view-family-shared-through-core` is what makes that
    // the console's only route to the cross-process leaf, and this is the line it names.
    expect(reachFor(doorPath, door, "../../../../shared/shutdown-budget.js")).toStrictEqual({
      takes: true,
      forwarded: true,
    });
    const dialogPath =
      "src/renderer/src/console/settings/pages/application/updates/RestartConfirmation.tsx";
    const dialog = readConsoleSourceModule(moduleNamed(modules, dialogPath));
    // And the one console reader USES it, through `core/` rather than past it.
    expect(reachFor(dialogPath, dialog, "../../../../core/index.js")).toStrictEqual({
      takes: true,
      forwarded: false,
    });
  });

  it("negative control: it catches the second home this rule was written for", () => {
    // The declaration main carried, verbatim, `as const` included — and the shape a
    // later hand would reach for first, a second budget beside the shared one.
    expect(
      declaredShutdownWaitBounds("m.ts", "const HARD_QUIT_CAP_MS = 5_000 as const;"),
    ).toStrictEqual(["HARD_QUIT_CAP_MS"]);
    expect(
      declaredShutdownWaitBounds("m.ts", "export const DRAIN_DEADLINE_MS = 5_000;"),
    ).toStrictEqual(["DRAIN_DEADLINE_MS"]);
  });

  it("negative control: it catches the literal default that declares no name", () => {
    const source = readConsoleSourceModule(moduleNamed(modules, "src/main/sidecar-lifecycle.ts"));
    const relapsed = source.replace(
      `deps.hardCapMs ?? ${BUDGET_BINDING}`,
      "deps.hardCapMs ?? 5_000",
    );
    expect(relapsed).not.toBe(source);
    expect(declaredShutdownWaitBounds("src/main/sidecar-lifecycle.ts", relapsed)).toStrictEqual([]);
    expect(hardCapDefaultOf(relapsed)).toBe("5_000");
  });

  it("negative control: a commented-out import is not a reach", () => {
    // The false GREEN a substring scan would ship: main can stop importing the budget
    // and keep the header sentence that names it, with the characters still on the page.
    const source = readConsoleSourceModule(moduleNamed(modules, "src/main/sidecar-lifecycle.ts"));
    const commentedOut = source
      .split("\n")
      .map((line) => (line.startsWith(`import { ${BUDGET_BINDING} }`) ? `// ${line}` : line))
      .join("\n");
    expect(commentedOut).not.toBe(source);
    expect(commentedOut).toContain(BUDGET_BINDING);
    expect(
      reachFor("src/main/sidecar-lifecycle.ts", commentedOut, "../shared/shutdown-budget.js").takes,
    ).toBe(false);
  });

  it("negative control: it passes the names that bound something else", () => {
    // The inner legs of the same drain, a duration that is not a bound, and the
    // injection seam — none of which is a second home for the shutdown ceiling.
    expect(
      declaredShutdownWaitBounds(
        "m.ts",
        [
          "const DEFAULT_SIDECAR_LIFECYCLE_TIMEOUTS = { perSessionTimeoutMs: 2_000 };",
          "const COMPOSING_RECEIVED_STALE_MS = 10_000;",
          "const hardCapMs = 5_000;",
          "const SHUTDOWN_BUDGET_LABEL = 'flush';",
        ].join("\n"),
      ),
    ).toStrictEqual([]);
  });
});
