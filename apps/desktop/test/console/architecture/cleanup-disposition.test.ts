// What a caller is told when a close did not go cleanly — and whose failure wins.
//
// Two questions, one subject. The first is which settlements a caller must be
// shown: cleanup that went wrong used to be breadcrumbed with `console.error`
// while the harness resolved anyway, and a log line is not a failure to vitest,
// so a tier whose assertions passed reported success while leaving an Electron
// alive for every launch after it. The second is what happens when the body
// ALSO failed, which is the ordinary case rather than the rare one — a wedged
// renderer is exactly the state in which an assertion fails and the close then
// loses its race.
//
// Both are reachable without an Electron, and that is the point of the shapes
// under test: `cleanupFailure` and `withCleanupOutcome` are functions over an
// outcome, and `closeAfterBody` takes the close alone, so a body that fails
// while the close also fails is one object literal. The race that PRODUCES
// those outcomes is `bounded-cleanup.test.ts`; these two files were one until
// it passed 400 lines carrying both subjects.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CleanupFailedError,
  type CleanupOutcome,
  type ClosableApplication,
  cleanupFailure,
  closeAfterBody,
  withCleanupOutcome,
} from "../bounded-cleanup.js";

describe("bounded cleanup — what a caller is told", () => {
  /** An outcome carrying whichever settlement a case is about. */
  function outcomeOf(settlement: CleanupOutcome["settlement"]): CleanupOutcome {
    return { settlement, waitedMs: 10_000, budgetMs: 10_000, processId: 4242 };
  }

  it("tells the caller nothing at all when the close was clean", () => {
    // The ordinary path. A sentence about cleanup on a run that cleaned up would
    // train a reader to skip the one that did not.
    expect(
      cleanupFailure({ settlement: "closed", waitedMs: 31, budgetMs: 10_000 }),
    ).toBeUndefined();
  });

  it.each(["unterminable", "closed-after-rejection"] as const)(
    "raises a failure the caller cannot ignore when the close settled %s",
    (settlement) => {
      // THE FINDING. Cleanup that went wrong was breadcrumbed with `console.error`
      // and the harness resolved anyway — and a log line is not a failure to
      // vitest, so a tier whose assertions passed reported success while leaving
      // an Electron alive for every launch after it. These are the two
      // settlements a LATER launch can feel: a process nothing could kill, and a
      // close that failed outright.
      const failure = cleanupFailure(outcomeOf(settlement));
      expect(failure).toBeInstanceOf(CleanupFailedError);
      expect(failure?.settlement).toBe(settlement);
      // Named, not merely counted: an operator told only that cleanup failed has
      // nothing to look for.
      expect(failure?.processId).toBe(4242);
      expect(failure?.message).toContain(settlement);
      expect(failure?.message).toContain("4242");
    },
  );

  it("lets a SIGKILLed tree pass, because the tree is gone", () => {
    // THE SECOND FINDING, and it is the mirror of the one above. `terminated`
    // says the close lost its race and the process tree was killed — which is
    // what `withCleanupOutcome` reports in the same breath as "later launches are
    // unaffected". Failing a tier over it would not catch a leak; it would catch
    // a healthy shutdown that ran long, which on the endurance tier is a close
    // bounded by the reserve alone after a full replay. The harness prints the
    // breadcrumb and the tier stays green.
    expect(cleanupFailure(outcomeOf("terminated"))).toBeUndefined();
    // Non-vacuous: the same outcome shape with the settlement that DOES reach a
    // later launch still raises, so this is the settlement deciding and not the
    // helper having stopped raising at all.
    expect(cleanupFailure(outcomeOf("unterminable"))).toBeInstanceOf(CleanupFailedError);
  });

  it("says so plainly when the process that would not close cannot be named", () => {
    // `processId()` answers `undefined` once Playwright has reaped the child, and
    // an error reading "pid undefined" is worse than one that admits it.
    // Built by hand: a default parameter would take `undefined` as "not supplied".
    const failure = cleanupFailure({ settlement: "unterminable", waitedMs: 10, budgetMs: 10_000 });
    expect(failure?.message).toContain("an unidentified process");
    expect(failure?.message).not.toContain("undefined");
  });

  it("warns about the profile lock only where a process may still hold it", () => {
    // `unterminable` is the settlement that breaks the NEXT launch —
    // `requestSingleInstanceLock()` is lost to a process nothing could kill — and
    // the one that earns the extra sentence. The other raising settlement, a
    // close that rejected while its process exited anyway, leaves nothing to
    // hold the lock and must not send a reader looking for one.
    expect(cleanupFailure(outcomeOf("unterminable"))?.message).toContain(
      "requestSingleInstanceLock",
    );
    expect(cleanupFailure(outcomeOf("closed-after-rejection"))?.message).not.toContain(
      "requestSingleInstanceLock",
    );
  });

  it("carries a rejected close as the cause rather than discarding it", () => {
    const rejection = new Error("Target page, context or browser has been closed");
    const failure = cleanupFailure({ ...outcomeOf("unterminable"), closeRejection: rejection });
    expect(failure?.cause).toBe(rejection);
  });

  it("keeps a launch failure on top and folds the cleanup into it", () => {
    // The launch-failure path. Two errors with the wrong one on top is how a
    // readiness timeout gets read as a cleanup defect, so there is one error: the
    // launch failure as `cause`, the cleanup as the sentence above it.
    const launchFailure = new Error("no animation frame arrived within 2000 ms");
    const folded = withCleanupOutcome(launchFailure, {
      ...outcomeOf("unterminable"),
      closeRejection: new Error("browser has been closed"),
    });
    expect(folded).toBeInstanceOf(Error);
    expect((folded as Error).cause).toBe(launchFailure);
    expect((folded as Error).message).toContain("close rejected: browser has been closed");
    expect((folded as Error).message).toContain("may still be running");
  });

  it("leaves a launch failure exactly as it was when the close was clean", () => {
    const launchFailure = new Error("no animation frame arrived within 2000 ms");
    expect(
      withCleanupOutcome(launchFailure, { settlement: "closed", waitedMs: 31, budgetMs: 10_000 }),
    ).toBe(launchFailure);
    // And when cleanup never ran at all, which is how the pre-readiness arms fail.
    expect(withCleanupOutcome(launchFailure, undefined)).toBe(launchFailure);
  });
});

describe("bounded cleanup — the body's failure survives its own cleanup", () => {
  /** The verdict a wedged close reaches, as a caller would be handed it. */
  function unterminableOutcome(): CleanupOutcome {
    return { settlement: "unterminable", waitedMs: 10_000, budgetMs: 10_000, processId: 4242 };
  }

  /** An application whose close raises that verdict. */
  function applicationWhoseCloseFails(): Pick<ClosableApplication, "close"> {
    return { close: () => Promise.reject(new CleanupFailedError(unterminableOutcome())) };
  }

  it("keeps the body's failure as the cause when the close failed too", async () => {
    // THE FINDING. Nine tiers awaited `close()` in a bare `finally`, and
    // JavaScript discards the in-flight completion when a `finally` block
    // throws — so the assertion naming a heap ceiling was destroyed and the
    // reader was handed a sentence about a process id. The two co-occur by
    // construction: a wedged renderer is exactly the state in which an assertion
    // fails AND the close then loses its race.
    const bodyFailure = new Error("expected renderer heap under the 120 MB ceiling");
    const raised = await closeAfterBody(applicationWhoseCloseFails(), () => {
      throw bodyFailure;
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((raised as Error).cause).toBe(bodyFailure);
    // And the cleanup is not lost either — it is the sentence above the cause,
    // which is `withCleanupOutcome`'s disposition rather than a second copy of
    // it, so the settlement that can break the NEXT launch still gets said.
    expect((raised as Error).message).toContain("may still be running");
  });

  it("surfaces the cleanup failure itself when the body succeeded", async () => {
    // The other half, and the reason this is not simply "always keep the body".
    // With nothing else to explain the run, an Electron nobody could kill IS the
    // failure, and a tier that swallowed it would go green while leaving a
    // process holding its profile for every launch after it.
    const raised = await closeAfterBody(applicationWhoseCloseFails(), async () =>
      Promise.resolve("measured"),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(raised).toBeInstanceOf(CleanupFailedError);
    expect((raised as CleanupFailedError).settlement).toBe("unterminable");
  });

  it("negative control: the bare `finally` the tiers used destroys the body's failure", async () => {
    // What the nine call sites did, run against the same two collaborators. This
    // is the case that fails on the old shape and passes on the new one, and it
    // is written out rather than described because "the `finally` wins" is the
    // whole finding — an `AssertionError` naming a ceiling, replaced by a
    // sentence about a pid.
    const bodyFailure = new Error("expected renderer heap under the 120 MB ceiling");
    const application = applicationWhoseCloseFails();
    const raisedByFinally = await (async () => {
      try {
        throw bodyFailure;
      } finally {
        await application.close();
      }
    })().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(raisedByFinally).not.toBe(bodyFailure);
    expect(raisedByFinally).toBeInstanceOf(CleanupFailedError);
    // The body's failure is not recoverable from the report either: the
    // cleanup error's own `cause` is the close rejection, never the assertion.
    expect((raisedByFinally as CleanupFailedError).cause).not.toBe(bodyFailure);
  });

  it("returns the body's value untouched when nothing went wrong", async () => {
    const value = await closeAfterBody({ close: () => Promise.resolve() }, async () =>
      Promise.resolve(120),
    );
    expect(value).toBe(120);
  });
});

describe("bounded cleanup — the harness spends both dispositions", () => {
  // The two call sites are inside a closure `launchConsole()` returns, reachable
  // only by launching a real Electron and then wedging it — which no fixture can
  // do. So the wiring is asserted against the source, the same instrument five
  // other tests in this tier already use for claims a running program cannot make
  // about itself. It is deliberately narrow: it checks that each disposition is
  // spent on its own path, not how the surrounding code reads.
  const harness = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "electron-harness.ts"),
    "utf8",
  );

  it("throws the failure on the ordinary path", () => {
    // Not `console.error(...)` and fall through, which is what it used to do.
    expect(harness).toMatch(/const failure = cleanupFailure\(cleanupOutcome\);/);
    expect(harness).toMatch(/\n\s*throw failure;/);
  });

  it("breadcrumbs a wider set than it throws on", () => {
    // The two are separate statements because `terminated` reaches one and not
    // the other: a SIGKILLed tree is worth a line in a CI log and is not worth a
    // red check. A breadcrumb guarded by the failure instead would print nothing
    // for exactly the settlement whose figures a reader needs to re-derive the
    // bound from.
    expect(harness).toMatch(/if \(cleanupOutcome\.settlement !== "closed"\) \{\s*console\.error\(/);
  });

  it("swallows that throw on the launch-failure path and attaches the outcome", () => {
    // `close()` now rejects, and on this path that rejection must not win — the
    // launch failure is the error that explains the run.
    expect(harness).toMatch(/try \{\s*await close\(\);\s*\} catch \{/);
    expect(harness).toMatch(/throw withCleanupOutcome\(error, cleanupOutcome\);/);
  });
});
