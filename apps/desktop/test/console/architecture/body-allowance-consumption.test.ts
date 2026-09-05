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

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { forEachDescendant, parseSourceText } from "../typescript-source.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE_TEST_DIRECTORY = resolve(HERE, "..");

/** The tiers whose tests run inside a launched console's body allowance. */
const LAUNCHING_TIER_DIRECTORIES: readonly string[] = ["e2e", "endurance"];

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

function launchingTierSources(): readonly { readonly path: string; readonly text: string }[] {
  return LAUNCHING_TIER_DIRECTORIES.flatMap((tier) => {
    const tierDirectory = join(CONSOLE_TEST_DIRECTORY, tier);
    return readdirSync(tierDirectory, { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith(".ts"))
      .sort()
      .map((entry) => ({
        path: `${tier}/${entry}`,
        text: readFileSync(join(tierDirectory, entry), "utf8"),
      }));
  });
}

describe("launched bodies charge every bounded wait to the allowance", () => {
  const sources = launchingTierSources();
  const calls = sources.flatMap((source) =>
    boundedWaitCalls(source.path, source.text).map((call) => ({ ...call, path: source.path })),
  );

  it("finds the tiers, and finds waits in them", () => {
    // Without this, a wrong directory or a needle that matches nothing would
    // scan an empty set and every assertion below would pass over it.
    expect(sources.map((source) => source.path)).toContain("e2e/frame-boot.test.ts");
    expect(sources.map((source) => source.path)).toContain("endurance/console-workload.ts");
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
