// A read is stoppable, a mutation is not, and the scheduler cannot produce either
// wrong — asserted against the source rather than against a reviewer's memory.
//
// THREE CLAIMS, ONE SUBJECT. `store/read-cancellation.ts` is where a read stops. The
// claims below are that it is the ONLY place one can be stopped from, that the
// scheduler pairs every read it fires with the round that stops it rather than
// leaving that to its caller, and that no run control anywhere reaches the mechanism.
// Each is structural: none of them is a rule a call site follows, and each fails on
// the edit that would break it rather than on the incident that would reveal it.
//
// WHY THE SCHEDULER CLAIM IS HERE AND NOT ONLY IN ITS OWN SUITE. `scheduling.read-
// round.test.ts` drives the real scheduler and asserts what a round DOES — live,
// superseded, abandoned on dispose. What it cannot assert is that no future
// `RefreshSchedulerOptions` member reopens the question by letting a caller supply a
// scope, or that a second scheduler-shaped class does not appear beside it. That is a
// claim about the shape of the source, so it is made where source-shape claims live.
// Neither suite subsumes the other: this one would pass over a scheduler that handed
// out a dead round, and that one would pass over a scheduler that accepted one.
//
// THE MUTATION CLAIM IS DERIVED, NOT LISTED. A hand-written roster of run-control
// modules is a roster that goes stale the first time a control moves, and the gate
// would keep passing while the module it was written about no longer exists. So the
// set is computed from the tree: a module that names one of the run-control wire
// methods AND calls the daemon door is a dispatcher, and every dispatcher found this
// way is held to the claim. The floor assertion below is what keeps that derivation
// from quietly reporting on nothing.
//
// THE HONEST LIMIT, the one every source-text tripwire has. This reads text, so an
// alias defeats it — a module that re-exported the controller under another name, or
// reached the scope through a value it was handed, is invisible here. The runtime
// counterparts are the ones that would catch those and they exist: the door's own
// abandonment suite plants a mutation beside an aborted line and asserts it was
// served, and the endurance tier drives a closed pane's read and asserts no
// projection ran. Text is the right instrument for the ordinary case because the
// ordinary case is what happens: a reader that needs a signal writes
// `new AbortController()` where it needs one.
//
// Test files are excluded by the shared source walk, which is load-bearing twice
// over: the door's abandonment suite constructs a controller on purpose to drive the
// door through its own contract, and this file writes every forbidden form below as a
// planted control.

import { describe, expect, it } from "vitest";

import {
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
  type ConsoleSourceModule,
} from "../console-source-modules.js";

/** The one module allowed to construct an abort controller. */
const READ_CANCELLATION_SEAM = "console/store/read-cancellation.ts";

/** The module whose pairing claim the second group is about. */
const REFRESH_SCHEDULER_MODULE = "console/store/scheduling.ts";

/** The one door a daemon call leaves the console through. */
const DAEMON_CALL_FORM = "callDaemon(";

/**
 * The wire methods that change a run, as a dispatcher writes them.
 *
 * Quoted, so the enumeration in the method registry — which names every method the
 * console can call, mutating and reading alike — is not mistaken for a dispatch. What
 * separates the two is the second conjunct below: a registry declares, a dispatcher
 * calls.
 */
const RUN_CONTROL_METHODS: readonly string[] = [
  '"run.pause"',
  '"run.resume"',
  '"run.intervene"',
  '"run.queueCancel"',
  '"run.queueCreate"',
];

/**
 * How a module shows it can stop a read, in the forms a call site writes.
 *
 * `new AbortController(` is the mint. The two specifier forms are the import, and
 * they carry `.js` because that is what an import specifier carries in this tree —
 * the prose in `generation-latch.ts` that names the seam by its `.ts` filename is
 * discussion of the seam and not a reach for it, which is exactly the line these
 * needles have to draw.
 */
const READ_CANCELLATION_FORMS: readonly string[] = [
  "new AbortController(",
  'read-cancellation.js"',
  "read-cancellation.js'",
];

/**
 * Every way `source` shows it can stop a read, or `[]`.
 *
 * A pure function over text so the controls below drive it with strings whose verdict
 * is known, and the checker is proved to bite without perturbing a module.
 */
function readCancellationSignatures(source: string): readonly string[] {
  return READ_CANCELLATION_FORMS.filter((form) => source.includes(form));
}

/** Whether `source` dispatches a run control: it names one AND calls the door. */
function dispatchesRunControl(source: string): boolean {
  return (
    source.includes(DAEMON_CALL_FORM) &&
    RUN_CONTROL_METHODS.some((method) => source.includes(method))
  );
}

/**
 * Every way `source` shows it touched a signal at all, or `[]`.
 *
 * DELIBERATELY WIDER THAN THE FORMS ABOVE. What the mutation claim needs is not that a
 * dispatcher failed to import the seam — it is that a dispatcher has nothing to do
 * with signals whatsoever, so a call that passed one along from a caller is an
 * offence here even though it minted nothing. The width is affordable because the
 * subject is small: four modules, none of which has any business naming an abort.
 */
function abortSignatures(source: string): readonly string[] {
  return ["AbortSignal", "AbortController", "signal", "abort"].filter((form) =>
    source.includes(form),
  );
}

/** The body of the named interface, or `""` if this source declares no such thing. */
function interfaceBody(source: string, interfaceName: string): string {
  const opening = `interface ${interfaceName} {`;
  const start = source.indexOf(opening);
  if (start === -1) {
    return "";
  }
  const body = source.slice(start + opening.length);
  const end = body.indexOf("\n}");
  return end === -1 ? body : body.slice(0, end);
}

describe("read cancellation — one seam, and nothing else can stop a read", () => {
  const modules: readonly ConsoleSourceModule[] = consoleSourceModules();

  it("finds a console tree to scan at all", () => {
    // Without this a wrong root would scan nothing and every assertion below would
    // pass over the empty set.
    expect(modules.length).toBeGreaterThan(20);
    expect(modules.map((module) => module.displayPath)).toContain(READ_CANCELLATION_SEAM);
  });

  it("no module outside the seam constructs an abort controller", () => {
    const offenders = modules
      .filter((module) => module.displayPath !== READ_CANCELLATION_SEAM)
      .map((module) => ({
        module: module.displayPath,
        minted: readConsoleSourceModule(module).includes("new AbortController("),
      }))
      .filter((entry) => entry.minted)
      .map((entry) => entry.module);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the seam itself trips the check", () => {
    // The clean result above is only meaningful if the needle matches real code.
    const seam = moduleNamed(modules, READ_CANCELLATION_SEAM);
    expect(readCancellationSignatures(readConsoleSourceModule(seam))).toContain(
      "new AbortController(",
    );
  });

  it("negative control: the predicate reads code and not prose", () => {
    // The two sides of the line the needles draw, against the predicate rather than
    // against whichever module happens to discuss the seam in a comment today.
    expect(
      readCancellationSignatures("// See `read-cancellation.ts` for why a round is two things."),
    ).toStrictEqual([]);
    expect(readCancellationSignatures("const controller = new AbortController();")).toStrictEqual([
      "new AbortController(",
    ]);
    expect(
      readCancellationSignatures('import { useReadScope } from "./read-cancellation.js";'),
    ).toStrictEqual(['read-cancellation.js"']);
  });
});

describe("read cancellation — the scheduler pairs every read it fires", () => {
  const modules: readonly ConsoleSourceModule[] = consoleSourceModules();
  const scheduler = (): string =>
    readConsoleSourceModule(moduleNamed(modules, REFRESH_SCHEDULER_MODULE));

  it("mints its own read scope rather than accepting one", () => {
    // The pairing is structural exactly here: a scope the scheduler owns is a scope
    // no caller can omit, replace, or share with a second scheduler.
    expect(scheduler()).toContain("readonly #readScope = new ReadScope();");
  });

  it("offers no option through which a caller could supply one", () => {
    // The other half, and the half that would rot first: an added member typed
    // `ReadScope` or `GenerationLatch` would reopen the question this class closed,
    // and would do it in the place a reviewer reads as configuration rather than as
    // a rule.
    const options = interfaceBody(scheduler(), "RefreshSchedulerOptions");
    expect(options).not.toBe("");
    expect(options).not.toContain("ReadScope");
    expect(options).not.toContain("GenerationLatch");
    expect(options).not.toContain("AbortSignal");
  });

  it("hands the round to the performer on every fire", () => {
    // Owning a scope and never opening a round on it would satisfy both assertions
    // above and stop nothing, so the third claim is that the round reaches the read.
    const source = scheduler();
    expect(source).toContain("round: ReadRound,");
    expect(source).toContain("const round = this.#readScope.openRound();");
    expect(source).toContain("await this.#perform(reasons, round);");
  });

  it("abandons the line when it is disposed", () => {
    // A scope that outlived its scheduler would leave a disposed reader's in-flight
    // read running, which is the case the runtime suite drives and this is the
    // source-shape half of.
    expect(scheduler()).toContain("this.#readScope.abandon();");
  });

  it("negative control: the interface reader finds a member that is there", () => {
    // The `not.toContain` assertions above would pass over an empty string, and an
    // empty string is what a renamed interface returns. The `not.toBe("")` guard is
    // what catches that; this proves the reader is reading the right body at all.
    const options = interfaceBody(scheduler(), "RefreshSchedulerOptions");
    expect(options).toContain("readonly perform: RefreshPerformer;");
    expect(interfaceBody(scheduler(), "NoSuchInterfaceExists")).toBe("");
  });

  it("negative control: an injectable scope would be caught", () => {
    // Written as the change that would defeat the claim, so the predicate is proved
    // against the shape it exists to refuse rather than only against today's source.
    const injectable = [
      "export interface RefreshSchedulerOptions {",
      "  readonly clock: ConsoleClock;",
      "  readonly readScope: ReadScope;",
      "}",
    ].join("\n");
    expect(interfaceBody(injectable, "RefreshSchedulerOptions")).toContain("ReadScope");
  });
});

describe("read cancellation — a run control is never handed one", () => {
  const modules: readonly ConsoleSourceModule[] = consoleSourceModules();
  const dispatchers = modules.filter((module) =>
    dispatchesRunControl(readConsoleSourceModule(module)),
  );

  it("finds the dispatchers to hold to the claim", () => {
    // The derivation's floor. A predicate that matched nothing would make every
    // assertion below vacuously true, which is the failure mode a derived set has
    // and a hand-written roster does not.
    expect(dispatchers.length).toBeGreaterThanOrEqual(2);
    expect(dispatchers.map((module) => module.displayPath)).toContain(
      "console/runs/pane/controls/run-control-dispatch.ts",
    );
  });

  it("no dispatcher names an abort at all", () => {
    const offenders = dispatchers
      .map((module) => ({
        module: module.displayPath,
        signatures: abortSignatures(readConsoleSourceModule(module)),
      }))
      .filter((entry) => entry.signatures.length > 0)
      .map((entry) => `${entry.module}: ${entry.signatures.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the dispatcher predicate needs both conjuncts", () => {
    // A registry names every method and calls nothing; a reader calls the door and
    // names no control. Neither is a dispatcher, and the predicate says so.
    expect(dispatchesRunControl('const BINDINGS = { "run.pause": pauseBinding };')).toBe(false);
    expect(dispatchesRunControl('await callDaemon(bridge, "presence.read", request);')).toBe(false);
    expect(dispatchesRunControl('await callDaemon(bridge, "run.pause", { targetRunId });')).toBe(
      true,
    );
  });

  it("negative control: a dispatcher that took a signal would be caught", () => {
    // The change the claim exists to refuse, driven through the predicate that would
    // have to catch it.
    expect(
      abortSignatures('await callDaemon(bridge, "run.pause", request, { signal: round.signal });'),
    ).toContain("signal");
    expect(abortSignatures('await callDaemon(bridge, "run.pause", request);')).toStrictEqual([]);
  });
});
