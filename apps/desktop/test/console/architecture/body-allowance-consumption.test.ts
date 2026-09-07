// Every bounded wait a launched body performs is charged to that body's allowance.
//
// `withLaunchedConsole` reserves an allowance for what runs between a settled
// launch and its cleanup, and hands the body `bodyAllowance` so a wait can ask
// for `boundedMs(<its own bound>)` — the smaller of the wait's own figure and
// what is left. A wait that ignores it is bounded by the wrong clock: a poll
// declaring ten seconds against an allowance with 200 ms on it runs past the
// allowance, and the enclosing race then settles first and replaces that poll's
// own message ("the scheme did not change") with the generic body-overrun
// sentence. What is lost is the diagnosis, on exactly the runs slow enough to
// need one — which is the failure the allowance was introduced to end, reappearing
// one layer in.
//
// So the rule is mechanical: in the two launching tiers, a bounded wait names
// `bodyAllowance`. It is asked of the WHOLE file rather than only of the
// lexical inside of a `withLaunchedConsole` call, because a helper those tiers
// call — `console-workload.ts`'s route transitions, its churn cycle — performs
// its waits inside the body just as much as one written there does, and the
// difference is where the code sits rather than what the clock is.
//
// A PARSER, NOT A PATTERN. Which calls a file makes is a question about the
// tree, and a pattern over the text answers it wrongly at the first nested
// object literal or multi-line argument list. `typescript-source.ts` holds the
// parse; the budget tier asks the same kind of question of the same parser.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { consoleSourceModules, readConsoleSourceModule } from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE_TEST_DIRECTORY = resolve(HERE, "..");

/** The tiers whose tests run inside a launched console's body allowance. */
const LAUNCHING_TIER_DIRECTORIES: readonly string[] = ["e2e", "endurance"];

/**
 * Flat `test/console/` modules a launched body calls, named one by one.
 *
 * The two tier directories are taken whole, because everything in them runs
 * inside a body. The flat directory beside them cannot be: `launch-readiness.ts`
 * waits there too, and its waits are the LAUNCH's — bounded by the launch
 * deadline, since no allowance exists until the launch has settled. So a shared
 * module that performs waits on the body's side of that line joins this list in
 * the commit that adds it, and a module scanned by neither rule is a wait bounded
 * by whatever it invented.
 */
const LAUNCH_BODY_SHARED_MODULES: readonly string[] = ["palette-interaction.ts"];

/**
 * The call names that take a timeout and wait it out.
 *
 * Playwright's waits plus Vitest's `expect.poll`. A call not on this list either
 * takes no timeout — `evaluate`, `press`, `type` — or is not a wait, and adding
 * one that carries a bound is how this rule grows.
 */
const BOUNDED_WAIT_METHODS: readonly string[] = [
  "waitFor",
  "waitForSelector",
  "waitForLoadState",
  "waitForFunction",
  "waitForTimeout",
  "reload",
  "poll",
];

/** The name a wait has to reach for the allowance to be consumed. */
const ALLOWANCE_IDENTIFIER = "bodyAllowance";

interface BoundedWaitCall {
  readonly method: string;
  readonly line: number;
  readonly consumesAllowance: boolean;
}

/** Whether `node` or anything under it names the allowance. */
function mentionsAllowance(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === ALLOWANCE_IDENTIFIER) {
    return true;
  }
  let found = false;
  forEachDescendant(node, (descendant) => {
    if (ts.isIdentifier(descendant) && descendant.text === ALLOWANCE_IDENTIFIER) {
      found = true;
    }
  });
  return found;
}

/**
 * Every bounded wait `sourceText` performs, and whether each consumes the allowance.
 *
 * A pure function over text rather than a loop inside a case, so the negative
 * controls below can drive it with inputs whose verdict is known and prove it
 * bites without perturbing a real tier.
 */
function boundedWaitCalls(fileName: string, sourceText: string): readonly BoundedWaitCall[] {
  const sourceFile = parseSourceText(fileName, sourceText);
  const calls: BoundedWaitCall[] = [];
  forEachDescendant(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
      return;
    }
    const method = node.expression.name.text;
    if (!BOUNDED_WAIT_METHODS.includes(method)) {
      return;
    }
    calls.push({
      method,
      line:
        sourceFile.getLineAndCharacterOfPosition(node.expression.name.getStart(sourceFile)).line +
        1,
      consumesAllowance: node.arguments.some((argument) => mentionsAllowance(argument)),
    });
  });
  return calls;
}

/** Whether a path under `test/console/` holds code that runs inside a launched body. */
function runsInsideALaunchedBody(path: string): boolean {
  const [head] = path.split("/");
  return (
    (head !== undefined && LAUNCHING_TIER_DIRECTORIES.includes(head)) ||
    LAUNCH_BODY_SHARED_MODULES.includes(path)
  );
}

/**
 * Every module that runs inside a launched body, through the tier's one walk.
 *
 * Not a `readdirSync` of its own: `source-walk-chokepoint.test.ts` next door
 * fails a gate in this directory that walks a tree itself, for the reason that
 * gate's header gives — a claim is only as good as the set it quantifies over,
 * and per-gate walks drift silently. ONE walk of `test/console/` filtered by the
 * predicate above rather than one walk per tier, because the shared modules sit
 * beside the tiers rather than inside them and a second walk to reach them is the
 * exact shape that chokepoint forbids. The tier prefix survives in `path` because
 * a failure here names a file the way a person opens it.
 */
function launchBodySources(): readonly { readonly path: string; readonly text: string }[] {
  return consoleSourceModules({ roots: [CONSOLE_TEST_DIRECTORY], tests: true })
    .map((module) => ({ module, path: module.relativePath.split("\\").join("/") }))
    .filter((candidate) => runsInsideALaunchedBody(candidate.path))
    .map((candidate) => ({
      path: candidate.path,
      text: readConsoleSourceModule(candidate.module),
    }));
}

describe("launched bodies charge every bounded wait to the allowance", () => {
  const sources = launchBodySources();
  const calls = sources.flatMap((source) =>
    boundedWaitCalls(source.path, source.text).map((call) => ({ ...call, path: source.path })),
  );

  it("finds the tiers, and finds waits in them", () => {
    // Without this, a wrong directory or a needle that matches nothing would
    // scan an empty set and every assertion below would pass over it.
    expect(sources.map((source) => source.path)).toContain("e2e/frame-boot.test.ts");
    expect(sources.map((source) => source.path)).toContain("endurance/console-workload.ts");
    // The shared half. Without it the list above would be satisfied by a scan that
    // dropped every flat module, which is the state that let a body's waits sit
    // outside this rule by being hoisted out of the tier that performs them.
    expect(sources.map((source) => source.path)).toContain("palette-interaction.ts");
    // And the line the predicate draws: the launch's own waits are bounded by the
    // launch deadline and are not this rule's subject.
    expect(sources.map((source) => source.path)).not.toContain("launch-readiness.ts");
    expect(calls.length, "the walk found no bounded wait at all").toBeGreaterThan(8);
  });

  it("leaves no bounded wait bounded by anything but the allowance", () => {
    const unconsumed = calls
      .filter((call) => !call.consumesAllowance)
      .map((call) => `${call.path}:${String(call.line)} ${call.method}()`);
    expect(unconsumed).toStrictEqual([]);
  });

  it("negative control: a wait with a bare timeout is reported", () => {
    // The shape this rule exists to catch, driven through the real predicate.
    // Without it, "no unconsumed waits" would also be the answer a checker that
    // matched nothing gives.
    const planted = [
      "await window.getByRole('dialog').waitFor({ state: 'visible', timeout: 10_000 });",
      "await expect.poll(readScheme, { timeout: 10_000 }).toBe('dark');",
      "await window.reload();",
    ].join("\n");
    expect(boundedWaitCalls("planted.ts", planted).map((call) => call.method)).toStrictEqual([
      "waitFor",
      "poll",
      "reload",
    ]);
    expect(boundedWaitCalls("planted.ts", planted).every((call) => !call.consumesAllowance)).toBe(
      true,
    );
  });

  it("negative control: the same waits pass once they draw on the allowance", () => {
    // The positive half. Without it the case above is ambiguous between "the
    // predicate reads the arguments" and "the predicate says no to everything".
    const charged = [
      "await window.getByRole('dialog').waitFor({",
      "  state: 'visible',",
      "  timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),",
      "});",
      "await expect",
      "  .poll(readScheme, { timeout: consoleApplication.bodyAllowance.remainingMs() })",
      "  .toBe('dark');",
    ].join("\n");
    expect(boundedWaitCalls("charged.ts", charged).every((call) => call.consumesAllowance)).toBe(
      true,
    );
  });

  it("negative control: a call that is not a wait is not reported", () => {
    // The line the method list draws. `evaluate` takes no timeout and waits on
    // nothing this rule can bound, so demanding an allowance of it would make
    // the rule unsatisfiable rather than stricter.
    const notWaits = [
      "await window.evaluate(() => document.title);",
      "await window.keyboard.press('Escape');",
    ].join("\n");
    expect(boundedWaitCalls("not-waits.ts", notWaits)).toStrictEqual([]);
  });
});
