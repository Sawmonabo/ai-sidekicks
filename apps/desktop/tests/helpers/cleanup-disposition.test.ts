// What a caller is told when a close did not go cleanly, and whose failure wins.
//
// Two questions: which settlements a caller must be shown (a log line is not a failure to vitest,
// so a tier could pass while leaving an Electron alive for every launch after it), and what
// happens when the body also failed, the ordinary case since a wedged renderer fails an assertion
// and then loses the close race. Both are reachable without an Electron: `cleanupFailure` and
// `withCleanupOutcome` are functions over an outcome, and `closeAfterBody` takes the close alone.
// The race that produces the outcomes is `bounded-cleanup.test.ts`.

import { describe, expect, it } from "vitest";

import { type CleanupOutcome, type ClosableApplication } from "./cleanup-contract.js";
import {
  CleanupFailedError,
  cleanupFailure,
  closeAfterBody,
  withCleanupOutcome,
  withProfileRemoval,
} from "./cleanup-disposition.js";

/** The directory a case names when it is about a profile that would not go. */
const LEFTOVER_PROFILE = "/tmp/ai-sidekicks-console-left";

describe("bounded cleanup — what a caller is told", () => {
  /** An outcome carrying whichever settlement a case is about. */
  function outcomeOf(settlement: CleanupOutcome["settlement"]): CleanupOutcome {
    return { settlement, waitedMs: 10_000, budgetMs: 10_000, processId: 4242 };
  }

  it("tells the caller nothing at all when the close was clean", () => {
    // The ordinary path: a sentence about cleanup on a run that cleaned up would train a reader
    // to skip the one that did not.
    expect(
      cleanupFailure({ settlement: "closed", waitedMs: 31, budgetMs: 10_000 }),
    ).toBeUndefined();
  });

  it.each(["unterminable", "closed-after-rejection"] as const)(
    "raises a failure the caller cannot ignore when the close settled %s",
    (settlement) => {
      // These are the two settlements a later launch can feel: a process nothing could kill, and
      // a close that failed outright. A log line would not fail a tier.
      const failure = cleanupFailure(outcomeOf(settlement));
      expect(failure).toBeInstanceOf(CleanupFailedError);
      expect(failure?.settlement).toBe(settlement);
      // Named, not merely counted: an operator needs something to look for.
      expect(failure?.processId).toBe(4242);
      expect(failure?.message).toContain(settlement);
      expect(failure?.message).toContain("4242");
    },
  );

  it("lets a SIGKILLed tree pass, because the tree is gone", () => {
    // `terminated` means the close lost its race and the tree was killed, which
    // `withCleanupOutcome` reports as "later launches are unaffected". Failing a tier over it
    // would catch a healthy shutdown that ran long, not a leak. The harness logs it and the tier
    // stays green.
    expect(cleanupFailure(outcomeOf("terminated"))).toBeUndefined();
    // Non-vacuous: the settlement that does reach a later launch still raises, so the settlement
    // is deciding and not a helper that stopped raising.
    expect(cleanupFailure(outcomeOf("unterminable"))).toBeInstanceOf(CleanupFailedError);
  });

  it("says so plainly when the process that would not close cannot be named", () => {
    // `processId()` answers `undefined` once Playwright has reaped the child, and an error
    // reading "pid undefined" is worse than one that admits it. Built by hand because a default
    // parameter would take `undefined` as "not supplied".
    const failure = cleanupFailure({ settlement: "unterminable", waitedMs: 10, budgetMs: 10_000 });
    expect(failure?.message).toContain("an unidentified process");
    expect(failure?.message).not.toContain("undefined");
  });

  it("warns about the profile lock only where a process may still hold it", () => {
    // `unterminable` breaks the next launch (`requestSingleInstanceLock()` is lost to a process
    // nothing could kill) and earns the extra sentence. A close that rejected while its process
    // exited anyway leaves nothing to hold the lock and must not send a reader looking for one.
    expect(cleanupFailure(outcomeOf("unterminable"))?.message).toContain(
      "requestSingleInstanceLock",
    );
    expect(cleanupFailure(outcomeOf("closed-after-rejection"))?.message).not.toContain(
      "requestSingleInstanceLock",
    );
  });

  it("raises on a profile that outlived its launch, even when the close was clean", () => {
    // A per-launch profile left on disk is felt by a later run, and the close here went
    // perfectly, the pairing a settlement-only rule would miss.
    const failure = cleanupFailure({
      settlement: "closed",
      waitedMs: 31,
      budgetMs: 10_000,
      profileRemovalFailure: { directory: LEFTOVER_PROFILE, failure: new Error("EBUSY") },
    });
    expect(failure).toBeInstanceOf(CleanupFailedError);
    // Named, so an operator has a path to look at.
    expect(failure?.message).toContain(LEFTOVER_PROFILE);
    expect(failure?.message).toContain("EBUSY");
    // It does not invent a close that went wrong: this one did not.
    expect(failure?.message).not.toContain("did not close cleanly");
    // Non-vacuous: the same clean close whose profile did come off disk raises nothing.
    expect(
      cleanupFailure({ settlement: "closed", waitedMs: 31, budgetMs: 10_000 }),
    ).toBeUndefined();
  });

  it("says both when the close went wrong AND the profile stayed", () => {
    // Neither fact displaces the other: the process that may still be running and the directory
    // that is still there are separately actionable.
    const worded = withCleanupOutcome(new Error("the launch failed"), {
      ...outcomeOf("unterminable"),
      profileRemovalFailure: { directory: LEFTOVER_PROFILE, failure: new Error("EPERM") },
    });
    expect((worded as Error).message).toContain("may still be running");
    expect((worded as Error).message).toContain(LEFTOVER_PROFILE);
    expect((worded as Error).cause).toBeInstanceOf(Error);
  });

  it("keeps a launch failure on top when the profile it minted would not go", () => {
    // The pre-launch arm: `electron.launch` threw, so there is no cleanup verdict for the removal
    // to ride, and raising it would replace the readiness failure that explains the run.
    const launchFailure = new Error("the console did not become ready");
    const folded = withProfileRemoval(launchFailure, {
      directory: LEFTOVER_PROFILE,
      failure: new Error("EPERM"),
    });
    expect((folded as Error).cause).toBe(launchFailure);
    expect((folded as Error).message).toContain(LEFTOVER_PROFILE);
    // Non-vacuous: a profile that did come off disk hands the failure back untouched.
    expect(withProfileRemoval(launchFailure, undefined)).toBe(launchFailure);
  });

  it("carries a rejected close as the cause rather than discarding it", () => {
    const rejection = new Error("Target page, context or browser has been closed");
    const failure = cleanupFailure({ ...outcomeOf("unterminable"), closeRejection: rejection });
    expect(failure?.cause).toBe(rejection);
  });

  it("keeps a launch failure on top and folds the cleanup into it", () => {
    // The launch-failure path: one error, with the launch failure as `cause` and the cleanup as
    // the sentence above it, so a readiness timeout is not read as a cleanup defect.
    const launchFailure = new Error("no animation frame arrived within 2000 ms");
    const folded = withCleanupOutcome(launchFailure, {
      ...outcomeOf("unterminable"),
      closeRejection: new Error("browser has been closed"),
    });
    expect(folded).toBeInstanceOf(Error);
    expect((folded as Error).cause).toBe(launchFailure);
    expect((folded as Error).message).toContain("rejected (browser has been closed)");
    expect((folded as Error).message).toContain("may still be running");
  });

  it("describes a close that REJECTED as one, rather than as a deadline expiry", () => {
    // `application.close()` can reject at once while the process is still alive, and cleanup then
    // terminates without waiting the budget out. The wording must say which happened: an expiry
    // is a wedged Electron, a rejection a close that failed outright.
    const bodyFailure = new Error("the scheme did not survive a reload");
    const folded = withCleanupOutcome(bodyFailure, {
      settlement: "terminated",
      waitedMs: 3,
      budgetMs: 10_000,
      processId: 4242,
      closeRejection: new Error("Target closed"),
    });
    const message = (folded as Error).message;
    expect(message).toContain("rejected (Target closed) after 3 ms");
    expect(message).toContain("rather than reaching the 10000 ms bound");
    expect(message).toContain("SIGKILLed");
    // Negative control: milliseconds beside "did not close within the 10000 ms it was given" is
    // the claim this replaces.
    expect(message).not.toContain("did not close within");
  });

  it("leaves the expiry wording alone when nothing rejected", () => {
    // Non-vacuous the other way: a close still outstanding when the bound expired did not
    // happen within the budget, and says so.
    const bodyFailure = new Error("the scheme did not survive a reload");
    const folded = withCleanupOutcome(bodyFailure, outcomeOf("terminated"));
    const message = (folded as Error).message;
    expect(message).toContain("did not close within the 10000 ms it was given (waited 10000 ms)");
    expect(message).toContain("SIGKILLed");
    expect(message).not.toContain("rejected (");
  });

  it("leaves a launch failure exactly as it was when the close was clean", () => {
    const launchFailure = new Error("no animation frame arrived within 2000 ms");
    expect(
      withCleanupOutcome(launchFailure, { settlement: "closed", waitedMs: 31, budgetMs: 10_000 }),
    ).toBe(launchFailure);
    // And when cleanup never ran at all, as in the pre-readiness arms.
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
    // A bare `finally` discards the in-flight completion when it throws, so the assertion naming
    // a heap ceiling would be replaced by a sentence about a process id. The two co-occur: a
    // wedged renderer fails an assertion and then loses the close race.
    const bodyFailure = new Error("expected renderer heap under the 120 MB ceiling");
    const raised = await closeAfterBody(applicationWhoseCloseFails(), () => {
      throw bodyFailure;
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((raised as Error).cause).toBe(bodyFailure);
    // The cleanup is not lost either: it is the sentence above the cause, by
    // `withCleanupOutcome`'s disposition.
    expect((raised as Error).message).toContain("may still be running");
  });

  it("surfaces the cleanup failure itself when the body succeeded", async () => {
    // The other half: with nothing else to explain the run, an Electron nobody could kill is the
    // failure, and swallowing it would leave a process holding its profile for later launches.
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
    // A bare `finally` run against the same collaborators: the `AssertionError` naming a ceiling
    // is replaced by a sentence about a pid. Written out because "the `finally` wins" is the
    // finding.
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
    // The body's failure is not recoverable from the report either: the cleanup error's `cause`
    // is the close rejection.
    expect((raisedByFinally as CleanupFailedError).cause).not.toBe(bodyFailure);
  });

  it("keeps the body's failure on top when the profile was what would not go", async () => {
    // The removal reaches a caller through the same disposition as every other cleanup fact: the
    // body's failure still explains the run and the leftover directory is the sentence above it.
    const bodyFailure = new Error("expected renderer heap under the 120 MB ceiling");
    const application = {
      close: () =>
        Promise.reject(
          new CleanupFailedError({
            settlement: "closed",
            waitedMs: 31,
            budgetMs: 10_000,
            profileRemovalFailure: { directory: LEFTOVER_PROFILE, failure: new Error("EBUSY") },
          }),
        ),
    };
    const raised = await closeAfterBody(application, () => {
      throw bodyFailure;
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((raised as Error).cause).toBe(bodyFailure);
    expect((raised as Error).message).toContain(LEFTOVER_PROFILE);
  });

  it("returns the body's value untouched when nothing went wrong", async () => {
    const value = await closeAfterBody({ close: () => Promise.resolve() }, async () =>
      Promise.resolve(120),
    );
    expect(value).toBe(120);
  });
});
