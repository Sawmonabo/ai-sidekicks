// One deadline for a whole tree kill, and what each command inside it is charged.
//
// `process-tree-readers.test.ts` beside this owns the bound on ONE command — the
// shared door taking the smaller of `HOST_QUERY_TIMEOUT_MS` and what it is
// handed, and spawning nothing at all once that reaches zero. That claim is
// about a single query and says nothing about a SEQUENCE of them, which is what
// a tree kill actually is: the root's start-stamp read, the whole-host
// process-table listing, a `taskkill` per addressable member, and a liveness
// reading per member, every one a `spawnSync` this thread blocks on.
//
// THE FINDING. Those commands were handed a NUMBER — the remainder read once,
// when `terminateProcessTree` was called — so each of them was entitled to the
// whole of it. `taskkill` could spend it and the fallback listing after it could
// spend it again, and one call overran its advertised deadline several times
// over before `BoundedCleanup` got the clock back to decide whether another
// attempt fitted. Vitest's timeout runs on that same blocked thread, so the
// overrun is paid in the `unterminable` verdict and the profile removal, which
// are the two things a later launch feels.
//
// WHY THE COMMANDS ARE INJECTED HERE. A macOS runner never enters the Windows
// arm, so a case that drove the real ones would be checking nothing on this
// host — and it would run a real `taskkill`, which these cases must never do.
// `externalTreeToolsOver` is therefore the seam: the same binding production
// takes, over a scripted command set and a clock the case moves by hand.

import { describe, expect, it } from "vitest";

import { terminateExternalTree } from "./process-tree/arms.js";
import { HostCommandBudget } from "./process-tree/budget.js";
import { externalTreeToolsOver, type ExternalHostCommands } from "./process-tree/dispatch.js";
import { SpawnedTreeIdentity } from "./process-tree/identity.js";
import { type ProcessTableRow } from "./process-tree/readers.js";
import { SteppedClock } from "./bounded-cleanup.test-support.js";
import { processTableOf } from "./process-table-fixture.test-support.js";

/** The tree under test: a live root with one descendant this host still lists. */
const ROOT_PID = 4242;
const DESCENDANT_PID = 4243;
const ROOT_STAMP = "638600000000000000";
const TREE_TABLE: ReadonlyMap<number, ProcessTableRow> = processTableOf([
  [DESCENDANT_PID, ROOT_PID, "638600000000000001"],
]);

/** A deadline short enough that a case can spend it in a few scripted commands. */
const TEST_DEADLINE_MS = 400;

/**
 * A command set that answers instantly, records what it was charged, and makes
 * the clock pay for it.
 *
 * The state the finding is about and the one no real platform produces on
 * demand: every query answers, slowly, and the tree survives all of them. Each
 * member charges `spendPerCommand` so a case can drive a whole sequence past
 * its deadline without waiting a single real second for a host query.
 */
function budgetRecordingHostCommands(
  clock: SteppedClock,
  spendPerCommand: number,
): ExternalHostCommands & { readonly charged: (number | undefined)[] } {
  const charged: (number | undefined)[] = [];
  const chargeAndAnswer = <T>(remainingBudgetMilliseconds: number | undefined, answer: T): T => {
    charged.push(remainingBudgetMilliseconds);
    clock.advance(spendPerCommand);
    return answer;
  };
  return {
    charged,
    killTreeFrom: (_processId, _forced, remainingBudgetMilliseconds) =>
      chargeAndAnswer(remainingBudgetMilliseconds, false),
    readProcessTable: (remainingBudgetMilliseconds) =>
      chargeAndAnswer(remainingBudgetMilliseconds, TREE_TABLE),
    hasTerminated: (_processId, remainingBudgetMilliseconds) =>
      chargeAndAnswer(remainingBudgetMilliseconds, false),
  };
}

/**
 * A root identity that reads `same` without touching this host.
 *
 * The verified arm is the one that walks the table, which is what puts several
 * commands in the sequence these cases measure. Both stamps are scripted equal
 * and the table reader answers the unreadable sentinel, so the capture refresh
 * is a no-op rather than a second source of rows.
 */
function verifiedIdentity(): SpawnedTreeIdentity {
  return new SpawnedTreeIdentity(
    ROOT_PID,
    () => ROOT_STAMP,
    () => undefined,
    () => true,
  );
}

describe("tree termination — every host command is charged to one shared deadline", () => {
  it("declines the figure across the sequence rather than repeating it", () => {
    // THE FINDING, read as the figures the commands received. Each one costs a
    // quarter of the deadline, so an honest deadline hands out 400, 300, 200,
    // 100 and then 0 — and the snapshot this replaces handed out 400 to every
    // one of them, which is how a single `terminate()` spent multiples of the
    // bound its caller had advertised.
    const clock = new SteppedClock();
    const hostCommands = budgetRecordingHostCommands(clock, TEST_DEADLINE_MS / 4);
    terminateExternalTree(
      ROOT_PID,
      "SIGKILL",
      externalTreeToolsOver(
        ROOT_PID,
        verifiedIdentity(),
        new HostCommandBudget(TEST_DEADLINE_MS, clock.read),
        hostCommands,
      ),
    );

    expect(
      hostCommands.charged.length,
      "the arm ran fewer than two host commands — this case is not measuring a sequence",
    ).toBeGreaterThan(1);
    expect(
      hostCommands.charged[0],
      "the first command was not entitled to the whole remainder",
    ).toBe(TEST_DEADLINE_MS);
    let previouslyCharged = TEST_DEADLINE_MS;
    for (const [commandIndex, budget] of hostCommands.charged.entries()) {
      expect(budget, `command ${String(commandIndex)} was charged no budget at all`).toBeTypeOf(
        "number",
      );
      const chargedMilliseconds = budget ?? 0;
      expect(
        chargedMilliseconds,
        `command ${String(commandIndex)} was charged a budget its predecessors had already spent — the remainder is a snapshot rather than a deadline`,
      ).toBeLessThanOrEqual(previouslyCharged);
      expect(chargedMilliseconds).toBeGreaterThanOrEqual(0);
      previouslyCharged = chargedMilliseconds;
    }
    expect(
      hostCommands.charged[hostCommands.charged.length - 1],
      "the sequence ran past its deadline still holding budget — the subtraction is not being re-read",
    ).toBe(0);
  });

  it("hands a command that follows an exhausted one nothing at all", () => {
    // The floor, and the half the door depends on: at or below zero it spawns
    // nothing, so a second command after one that overran must arrive there
    // with 0 rather than with the figure the first one was given. One command
    // per case-scripted spend of the WHOLE deadline makes that unambiguous.
    const clock = new SteppedClock();
    const hostCommands = budgetRecordingHostCommands(clock, TEST_DEADLINE_MS * 2);
    terminateExternalTree(
      ROOT_PID,
      "SIGKILL",
      externalTreeToolsOver(
        ROOT_PID,
        verifiedIdentity(),
        new HostCommandBudget(TEST_DEADLINE_MS, clock.read),
        hostCommands,
      ),
    );

    expect(hostCommands.charged[0]).toBe(TEST_DEADLINE_MS);
    expect(
      hostCommands.charged.slice(1),
      "a command that followed one which had already overrun was charged something other than zero — the door would spawn on an expired deadline",
    ).toStrictEqual(hostCommands.charged.slice(1).map(() => 0));
  });

  it("negative control: a deadline nothing spends charges every command in full", () => {
    // Without the control the cases above are ambiguous between "the budget is
    // charged as it is spent" and "the budget only ever shrinks", and the
    // second would pass over a binding that decremented on its own. Same seam,
    // same deadline, commands that cost the clock nothing.
    const clock = new SteppedClock();
    const hostCommands = budgetRecordingHostCommands(clock, 0);
    terminateExternalTree(
      ROOT_PID,
      "SIGKILL",
      externalTreeToolsOver(
        ROOT_PID,
        verifiedIdentity(),
        new HostCommandBudget(TEST_DEADLINE_MS, clock.read),
        hostCommands,
      ),
    );

    expect(new Set(hostCommands.charged)).toStrictEqual(new Set([TEST_DEADLINE_MS]));
  });

  it("negative control: a caller holding no deadline is handed no bound", () => {
    // The unbounded arm, which most callers take — the capture at a spawn is
    // inside nobody's disposal. A binding that invented a figure here would put
    // every one of these commands under a ceiling nobody asked for, and one
    // that floored it at zero would refuse to run them at all.
    const clock = new SteppedClock();
    const hostCommands = budgetRecordingHostCommands(clock, TEST_DEADLINE_MS);
    terminateExternalTree(
      ROOT_PID,
      "SIGKILL",
      externalTreeToolsOver(
        ROOT_PID,
        verifiedIdentity(),
        new HostCommandBudget(undefined, clock.read),
        hostCommands,
      ),
    );

    expect(new Set(hostCommands.charged)).toStrictEqual(new Set([undefined]));
  });
});

describe("the shared deadline itself, read directly", () => {
  it("subtracts what has elapsed and floors the answer at zero", () => {
    const clock = new SteppedClock();
    const budget = new HostCommandBudget(TEST_DEADLINE_MS, clock.read);
    expect(budget.remainingMilliseconds()).toBe(TEST_DEADLINE_MS);
    clock.advance(TEST_DEADLINE_MS / 4);
    expect(budget.remainingMilliseconds()).toBe(TEST_DEADLINE_MS * 0.75);
    // Past the deadline the honest answer is zero and never a negative number:
    // the door refuses at or below zero, and a growing negative would say the
    // same thing in a form no reader can compare against a bound.
    clock.advance(TEST_DEADLINE_MS * 4);
    expect(budget.remainingMilliseconds()).toBe(0);
  });

  it("negative control: an absent budget stays absent however long it is held", () => {
    const clock = new SteppedClock();
    const unbounded = new HostCommandBudget(undefined, clock.read);
    expect(unbounded.remainingMilliseconds()).toBeUndefined();
    clock.advance(TEST_DEADLINE_MS * 4);
    expect(unbounded.remainingMilliseconds()).toBeUndefined();
  });
});
