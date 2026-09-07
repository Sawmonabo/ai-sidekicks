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
// AND WHICH MODULES THOSE ARE IS DERIVED, NOT LISTED. The flat helpers were named
// one by one, which made the scanned set a closed list with no reader: the next
// helper a body called was outside the rule and nothing anywhere said so. The set
// is now the tiers plus everything they import, transitively, stopped at the
// launcher — `withLaunchedConsole` is the line between the launch's clock and the
// body's, so a module reached only through it is the launch's machinery and a
// module reached any other way is the body's. The reach is read by
// `source-walk-census.ts`'s `moduleSpecifiersIn`, which is the same reader the
// spawn chokepoint and the parse-home gate ask their reach questions through.
//
// A PARSER, NOT A PATTERN. Which calls a file makes is a question about the
// tree, and a pattern over the text answers it wrongly at the first nested
// object literal or multi-line argument list. `typescript-source.ts` holds the
// parse; the budget tier asks the same kind of question of the same parser.

import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  consoleSourceModules,
  readConsoleSourceModule,
  TYPESCRIPT_MODULE_EXTENSIONS,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";
import { moduleSpecifiersIn } from "./source-walk-census.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE_TEST_DIRECTORY = resolve(HERE, "..");

/** The tiers whose tests run inside a launched console's body allowance. */
const LAUNCHING_TIER_DIRECTORIES: readonly string[] = ["e2e", "endurance"];

/**
 * The launcher, which is the EDGE the body's side of this rule stops at.
 *
 * The line this rule draws is real and was drawn by hand: `launch-readiness.ts`
 * performs bounded waits too, and they are the LAUNCH's — held to the launch
 * deadline, since no allowance exists until the launch has settled. What was
 * wrong was the instrument. A roster of shared body helpers named
 * `palette-interaction.ts` and nothing else, so the next flat module an e2e or
 * endurance body called was silently outside the claim this file makes — the
 * stale closed set `apps/desktop/AGENTS.md` prohibits, in the shape it warns
 * about: nothing reports a set that quietly stopped covering its own sentence.
 *
 * Reachability draws the same line mechanically, because `withLaunchedConsole` IS
 * that line: the launcher's own imports are the launch's machinery, and a module
 * a body reaches by any path OTHER than through the launcher runs inside the
 * body. So the walk is seeded with the tiers and closed over their imports, and
 * this one name is where the closure stops.
 */
const LAUNCHER_MODULE = "electron-harness.ts";

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

/** Whether a path under `test/console/` sits inside one of the launching tiers. */
function isLaunchingTierModule(path: string): boolean {
  const [head] = path.split("/");
  return head !== undefined && LAUNCHING_TIER_DIRECTORIES.includes(head);
}

/**
 * Which module a relative specifier names, as a path inside `test/console/`.
 *
 * `undefined` for everything that leaves the tier — a package, the renderer tree,
 * `test/helpers/` — because the subject of this rule is the flat modules beside
 * the tiers and a specifier that lands outside the walk's own set has nothing to
 * resolve to. An ESM specifier carries the COMPILED name, so the extension is
 * swapped for each of the declared TypeScript ones rather than trusted; the set
 * comes from `console-source-modules.ts`, which is the same one the walk that
 * produced `known` admitted by.
 */
function resolveWithinTier(
  fromPath: string,
  specifier: string,
  known: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const resolved = posix.normalize(`${posix.dirname(fromPath)}/${specifier}`);
  const withoutExtension = resolved.replace(/\.[cm]?js$/u, "");
  for (const extension of TYPESCRIPT_MODULE_EXTENSIONS) {
    const candidate = `${withoutExtension}${extension}`;
    if (known.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Every module a launched body reaches, closed over imports and stopped at the launcher.
 *
 * A pure function over the walk's own modules, so the planted control below can
 * drive it with a corpus whose verdict is known. The tiers are seeds rather than
 * the answer: everything in them runs inside a body, and what they IMPORT runs
 * inside one too unless the path to it goes through the launcher.
 */
function launchBodyModulePaths(
  modules: readonly { readonly path: string; readonly text: string }[],
): ReadonlySet<string> {
  const known = new Set(modules.map((module) => module.path));
  const sourceByPath = new Map(modules.map((module) => [module.path, module.text]));
  const reached = new Set<string>();
  const frontier = modules.map((module) => module.path).filter(isLaunchingTierModule);
  while (frontier.length > 0) {
    const current = frontier.pop();
    if (current === undefined || reached.has(current) || current.endsWith(LAUNCHER_MODULE)) {
      continue;
    }
    reached.add(current);
    const source = sourceByPath.get(current);
    if (source === undefined) {
      continue;
    }
    for (const specifier of moduleSpecifiersIn(source, current)) {
      const target = resolveWithinTier(current, specifier, known);
      if (target !== undefined && !reached.has(target)) {
        frontier.push(target);
      }
    }
  }
  return reached;
}

/**
 * Every module that runs inside a launched body, through the tier's one walk.
 *
 * Not a `readdirSync` of its own: `source-walk-chokepoint.test.ts` next door
 * fails a gate in this directory that walks a tree itself, for the reason that
 * gate's header gives — a claim is only as good as the set it quantifies over,
 * and per-gate walks drift silently. ONE walk of `test/console/`, filtered by the
 * reachability above rather than by a hand-kept list, because the shared modules
 * sit beside the tiers rather than inside them and a second walk to reach them is
 * the exact shape that chokepoint forbids. The tier prefix survives in `path`
 * because a failure here names a file the way a person opens it.
 */
function launchBodySources(): readonly { readonly path: string; readonly text: string }[] {
  const tierModules = consoleSourceModules({ roots: [CONSOLE_TEST_DIRECTORY], tests: true }).map(
    (module) => ({
      path: module.relativePath.split("\\").join("/"),
      text: readConsoleSourceModule(module),
    }),
  );
  const reached = launchBodyModulePaths(tierModules);
  return tierModules.filter((module) => reached.has(module.path));
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
    // And the half a hand-kept roster could not have: a flat module the tiers
    // import that nobody thought to list, in the set because it is reached.
    expect(sources.map((source) => source.path)).toContain("launch-body.ts");
    // The line the reachability draws: the launch's own waits are bounded by the
    // launch deadline and are not this rule's subject, and `launch-readiness.ts`
    // is reached only THROUGH the launcher, which is where the closure stops.
    expect(sources.map((source) => source.path)).not.toContain("launch-readiness.ts");
    expect(calls.length, "the walk found no bounded wait at all").toBeGreaterThan(8);
  });

  it("leaves no bounded wait bounded by anything but the allowance", () => {
    const unconsumed = calls
      .filter((call) => !call.consumesAllowance)
      .map((call) => `${call.path}:${String(call.line)} ${call.method}()`);
    expect(unconsumed).toStrictEqual([]);
  });

  it("negative control: a helper a body reaches is scanned, and one only the launcher reaches is not", () => {
    // THE FINDING, driven through the real derivation. The corpus is four
    // modules: a tier test, a flat helper it calls, the launcher it also calls,
    // and a flat helper only the launcher calls. Under the roster this replaced,
    // the first flat helper was invisible — it is not `palette-interaction.ts` —
    // and its uncharged wait was reported by nothing.
    const planted: readonly { readonly path: string; readonly text: string }[] = [
      {
        path: "e2e/planted-boot.test.ts",
        text: [
          'import { withLaunchedConsole } from "../electron-harness.js";',
          'import { openPlantedPalette } from "../planted-interaction.js";',
          "export const body = [withLaunchedConsole, openPlantedPalette];",
        ].join("\n"),
      },
      {
        path: "planted-interaction.ts",
        text: [
          "export async function openPlantedPalette(window) {",
          "  await window.getByRole('dialog').waitFor({ state: 'visible', timeout: 10_000 });",
          "}",
        ].join("\n"),
      },
      {
        path: "electron-harness.ts",
        text: 'import { awaitPlantedReadiness } from "./planted-readiness.js";',
      },
      {
        path: "planted-readiness.ts",
        text: [
          "export async function awaitPlantedReadiness(window) {",
          "  await window.waitForFunction(() => true, undefined, { timeout: 10_000 });",
          "}",
        ].join("\n"),
      },
    ];

    const reached = launchBodyModulePaths(planted);
    expect([...reached].sort()).toStrictEqual([
      "e2e/planted-boot.test.ts",
      "planted-interaction.ts",
    ]);
    // And the reached helper's uncharged wait is what the gate then reports —
    // the half that makes the derived set worth deriving.
    const unconsumed = planted
      .filter((module) => reached.has(module.path))
      .flatMap((module) =>
        boundedWaitCalls(module.path, module.text)
          .filter((call) => !call.consumesAllowance)
          .map((call) => `${module.path}:${String(call.line)} ${call.method}()`),
      );
    expect(unconsumed).toStrictEqual(["planted-interaction.ts:2 waitFor()"]);
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
