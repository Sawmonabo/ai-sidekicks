// Nine dispositions, and the two rules the design says are never silent.
//
// The reading is a pure function over the registered result union, so every arm is
// drivable here without a bridge and without a rendered tree — which is exactly why
// the exhaustive switch was worth building as a function rather than as JSX.
//
// The cases assert three things a screenshot cannot: that the two file
// enumerations survive on all three arms that carry them (including when they are
// empty, which is a fact and not an omission), that `boundary-diverged` renders the
// wire's own `null` rather than a stand-in, and that `resendDisposition` is READ
// rather than derived from the disposition name.

import { describe, expect, it } from "vitest";
import type {
  RollbackAppliedResendOutcome,
  RollbackAppliedResult,
  RollbackDegradedResendOutcome,
  RollbackDegradedResult,
} from "@ai-sidekicks/contracts";

import {
  compositeGuardReading,
  readAppliedRollback,
  readDegradedRollback,
  resendSettlementSentence,
} from "./rollback-result.js";

/** Every `applied` arm the contract admits. Two, and the type says so. */
const APPLIED_ARMS: readonly (RollbackAppliedResult & RollbackAppliedResendOutcome)[] = [
  { disposition: "files-restored", overwrittenIgnoredPaths: [], divergentGitlinks: [] },
  { disposition: "conversation-only" },
];

/** Every `degraded` arm the contract admits. Seven, and the type says so. */
const DEGRADED_ARMS: readonly (RollbackDegradedResult & RollbackDegradedResendOutcome)[] = [
  {
    disposition: "files-partially-restored",
    failedStep: "restore-worktree",
    overwrittenIgnoredPaths: [".env.local"],
    divergentGitlinks: ["vendor/lib"],
  },
  { disposition: "files-unrestored" },
  { disposition: "pause-only" },
  { disposition: "nothing-applied" },
  { disposition: "position-mismatch", requestedPosition: 12, confirmedPosition: 9 },
  { disposition: "boundary-diverged", confirmedPosition: 9, newestBoundaryPosition: null },
  {
    disposition: "resend-unapplied",
    resendDisposition: "unapplied",
    overwrittenIgnoredPaths: [],
    divergentGitlinks: [],
  },
];

describe("the two settlement classes", () => {
  it("covers nine dispositions across the two classes", () => {
    // Vacuity guard: every case below iterates one of these two lists.
    expect(APPLIED_ARMS).toHaveLength(2);
    expect(DEGRADED_ARMS).toHaveLength(7);
  });

  it("reads every applied arm as applied and every degraded arm as degraded", () => {
    for (const arm of APPLIED_ARMS) {
      expect(readAppliedRollback(arm).settlementClass).toBe("applied");
    }
    for (const arm of DEGRADED_ARMS) {
      expect(readDegradedRollback(arm).settlementClass).toBe("degraded");
    }
  });

  it("renders the disposition verbatim, never a reworded one", () => {
    for (const arm of APPLIED_ARMS) {
      expect(readAppliedRollback(arm).disposition).toBe(arm.disposition);
    }
    for (const arm of DEGRADED_ARMS) {
      expect(readDegradedRollback(arm).disposition).toBe(arm.disposition);
    }
  });

  it("negative control: a degraded arm is never reported as a success", () => {
    // The class is taken from the arm's own type. A reading that inferred it from
    // the disposition name would have to guess, and `files-partially-restored`
    // reads as a restore.
    for (const arm of DEGRADED_ARMS) {
      expect(readDegradedRollback(arm).settlementClass).not.toBe("applied");
    }
  });
});

describe("the two enumerations that are never silent", () => {
  it("carries both on exactly the three arms whose contract requires them", () => {
    expect(
      readAppliedRollback({
        disposition: "files-restored",
        overwrittenIgnoredPaths: [],
        divergentGitlinks: [],
      }).files,
    ).toStrictEqual({ overwrittenIgnoredPaths: [], divergentGitlinks: [] });

    expect(
      readDegradedRollback({
        disposition: "files-partially-restored",
        failedStep: "restore-worktree",
        overwrittenIgnoredPaths: [".env.local"],
        divergentGitlinks: ["vendor/lib"],
      }).files,
    ).toStrictEqual({
      overwrittenIgnoredPaths: [".env.local"],
      divergentGitlinks: ["vendor/lib"],
    });

    expect(
      readDegradedRollback({
        disposition: "resend-unapplied",
        resendDisposition: "unapplied",
        overwrittenIgnoredPaths: [],
        divergentGitlinks: [],
      }).files,
    ).toStrictEqual({ overwrittenIgnoredPaths: [], divergentGitlinks: [] });
  });

  it("keeps an EMPTY enumeration rather than dropping it", () => {
    // An empty list means nothing was overwritten; dropping it would make that
    // indistinguishable from not having looked, which is the conflation the
    // never-silent mandate exists to prevent.
    const reading = readDegradedRollback({
      disposition: "resend-unapplied",
      resendDisposition: "unapplied",
      overwrittenIgnoredPaths: [],
      divergentGitlinks: [],
    });
    expect(reading.files).toBeDefined();
    expect(reading.files?.overwrittenIgnoredPaths).toStrictEqual([]);
  });

  it("negative control: an arm with no enumerations carries none", () => {
    // Without this the case above would also pass over a reading that attached an
    // empty pair to every arm, which would claim a file leg on `pause-only`.
    expect(readDegradedRollback({ disposition: "pause-only" }).files).toBeUndefined();
    expect(readAppliedRollback({ disposition: "conversation-only" }).files).toBeUndefined();
  });
});

describe("daemon-supplied positions", () => {
  it("renders both positions on a mismatch", () => {
    const reading = readDegradedRollback({
      disposition: "position-mismatch",
      requestedPosition: 12,
      confirmedPosition: 9,
    });
    expect(reading.positions.map((entry) => entry.position)).toStrictEqual([12, 9]);
  });

  it("renders the wire's own null on a boundary divergence", () => {
    // Required-and-nullable: a position-less compaction row classifies as crossing
    // for every target of that run, so `null` states the cause and a stand-in
    // number would invent one.
    const reading = readDegradedRollback({
      disposition: "boundary-diverged",
      confirmedPosition: 9,
      newestBoundaryPosition: null,
    });
    expect(reading.positions.map((entry) => entry.position)).toStrictEqual([9, null]);
    expect(reading.isNonResumable).toBe(true);
  });

  it("negative control: no other arm is marked non-resumable", () => {
    for (const arm of DEGRADED_ARMS.filter((entry) => entry.disposition !== "boundary-diverged")) {
      expect(readDegradedRollback(arm).isNonResumable).toBe(false);
    }
  });
});

describe("the replacement leg", () => {
  it("reads `resendDisposition` off the result rather than inferring it", () => {
    expect(
      readAppliedRollback({
        disposition: "conversation-only",
        resendDisposition: "admitted",
      }).resendDisposition,
    ).toBe("admitted");
    expect(
      readDegradedRollback({
        disposition: "resend-unapplied",
        resendDisposition: "unapplied",
        overwrittenIgnoredPaths: [],
        divergentGitlinks: [],
      }).resendDisposition,
    ).toBe("unapplied");
  });

  it("negative control: a bare rollback carries no resend reading", () => {
    // The member is schema-optional because no member of a result identifies its
    // request as composite; a reading that defaulted it would report a replacement
    // outcome for a request that carried no replacement.
    expect(
      readAppliedRollback({ disposition: "conversation-only" }).resendDisposition,
    ).toBeUndefined();
    expect(resendSettlementSentence(undefined)).toBeUndefined();
  });

  it("says the replacement is queued and never that it was sent", () => {
    const sentence = resendSettlementSentence("admitted");
    expect(sentence).toBeDefined();
    expect(sentence).toContain("queued");
    expect(sentence?.toLowerCase()).not.toContain("sent");
  });

  it("says an unapplied replacement stays recoverable", () => {
    expect(resendSettlementSentence("unapplied")).toContain("recoverable");
  });
});

describe("the four structural guards a composite is refused whole by", () => {
  it.each([
    ["no active turn", "composite.no_active_turn", "no-active-turn"],
    ["an accepted-but-undelivered send", "rollback.pending_send", "no-pending-send"],
    ["an undrained queued send", "composite.queued_send_present", "no-pending-send"],
    [
      "an orchestration-authored boundary",
      "target.not_participant_authored",
      "participant-authored-boundary",
    ],
    ["a workflow phase input", "boundary.orchestration_authored", "participant-authored-boundary"],
    ["a rootless target", "run.rootless_not_resumable", "resumable-target"],
    ["a target that can never resume", "target.non_resumable", "resumable-target"],
  ])("recognises %s", (_name, rejectionReason, guard) => {
    expect(compositeGuardReading(rejectionReason)?.guard).toBe(guard);
  });

  it("recognises the check whatever the daemon's spelling of it", () => {
    // `rejectionReason` is a free-form wire string and no closed union is registered
    // for these four, so what is matched is the check's own name rather than one
    // guessed identifier — across the three shapes a producer plausibly sends.
    const guards = [
      "no_pending_send",
      "composite.pendingSend",
      "A pending send exists on this run.",
    ].map((reason) => compositeGuardReading(reason)?.guard);

    expect(guards).toStrictEqual(["no-pending-send", "no-pending-send", "no-pending-send"]);
  });

  it("names the pending-send remedy as an act, since nothing in the form can clear it", () => {
    const reading = compositeGuardReading("composite.pending_send");

    expect(reading?.remedy).toContain("Cancel the queued items");
    expect(reading?.remedy).toContain("drain");
  });

  it("gives each guard its own words, so four refusals never read as one", () => {
    const readings = [
      "composite.no_active_turn",
      "composite.pending_send",
      "target.not_participant_authored",
      "target.non_resumable",
    ].map((reason) => compositeGuardReading(reason));
    const remedies = readings.map((reading) => reading?.remedy);

    expect(new Set(remedies).size).toBe(4);
    for (const reading of readings) {
      expect(reading?.refused.length ?? 0).toBeGreaterThan(20);
    }
  });

  it.each([
    ["a bare rollback's capability refusal", "driver.capability_unsupported"],
    ["a stale comparand", "run.version_conflict"],
    ["a transition the run does not admit", "run.invalid_transition"],
    ["the empty string", ""],
  ])("invents no guard for %s", (_name, rejectionReason) => {
    // The negative control for the whole reading: telling a person to drain a queue
    // that has nothing in it is worse than showing the wire code alone.
    expect(compositeGuardReading(rejectionReason)).toBeUndefined();
  });
});
