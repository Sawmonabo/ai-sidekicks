// The resume rule, driven directly.
//
// Every case here is the contract's own sentence turned into an assertion, and every
// clean result has the negative control the rule needs to mean anything: a predicate
// that answered "resume from earliest" for every input would satisfy half of these
// on its own, and one that refused everything would satisfy the other half.

import { describe, expect, it } from "vitest";

import { isConsoleRefusal } from "../core/index.js";
import {
  resolveTimelineResume,
  TIMELINE_RESUME_ORIGIN,
  TIMELINE_RESUME_REFUSAL_CODES,
} from "./timeline-resume.js";

/** The V1 floor, spelled the way the contract states it: `encode(-1)`. */
const EARLIEST = "-1_1723291400000000000";
/** A position above the floor. */
const ACKNOWLEDGED = "41_1723291480000000000";
const LATEST = "42_1723291500000000000";

describe("the resume rule takes `acknowledged ?? earliest`", () => {
  it("resumes from the acknowledged position when the read carries one", () => {
    const decision = resolveTimelineResume({
      earliest: EARLIEST,
      latest: LATEST,
      acknowledged: ACKNOWLEDGED,
    });

    expect(decision.outcome).toBe("resume");
    expect(decision.outcome === "resume" ? decision.fromCursor : undefined).toBe(ACKNOWLEDGED);
  });

  it("falls back to the floor when nothing has been acknowledged", () => {
    // The first read of a session, which is the ordinary case and deliberately not a
    // reset: nothing was acknowledged because nothing had been read, not because
    // anything was lost.
    const decision = resolveTimelineResume({ earliest: EARLIEST, latest: LATEST });

    expect(decision.outcome).toBe("resume");
    expect(decision.outcome === "resume" ? decision.fromCursor : undefined).toBe(EARLIEST);
  });
});

describe("an acknowledged position below the floor means events were lost", () => {
  it("resets the projection and resumes from the floor", () => {
    // `decode(acknowledged) < decode(earliest)`: the rows between the two are gone,
    // so the projection built on them is a projection of rows the daemon no longer
    // has.
    const decision = resolveTimelineResume({
      earliest: "900_1723291400000000000",
      latest: "1200_1723291500000000000",
      acknowledged: "120_1723200000000000000",
    });

    expect(decision.outcome).toBe("reset");
    expect(decision.outcome === "reset" ? decision.fromCursor : undefined).toBe(
      "900_1723291400000000000",
    );
  });

  it("negative control: the same pair the right way round resumes without a reset", () => {
    // Without this, a rule that reset on every acknowledged cursor would pass the
    // case above — and would throw away a whole projection on every reconnect.
    const decision = resolveTimelineResume({
      earliest: "120_1723200000000000000",
      latest: "1200_1723291500000000000",
      acknowledged: "900_1723291400000000000",
    });

    expect(decision.outcome).toBe("resume");
    expect(decision.outcome === "resume" ? decision.fromCursor : undefined).toBe(
      "900_1723291400000000000",
    );
  });

  it("treats an equal pair as resumable rather than lost", () => {
    // The floor is the position immediately BEFORE the oldest surviving row, so an
    // acknowledged position equal to it has lost nothing — the comparison the
    // contract states is strict.
    const decision = resolveTimelineResume({
      earliest: EARLIEST,
      latest: LATEST,
      acknowledged: EARLIEST,
    });

    expect(decision.outcome).toBe("resume");
  });
});

describe("a cursor pair this console cannot order refuses the cycle", () => {
  it("refuses rather than guessing which side of the floor the acknowledged cursor is", () => {
    // The cursor is opaque by contract. Where its leading position cannot be read,
    // the console neither resumes past rows it cannot account for nor discards a
    // projection on a loss nothing established — it declines the cycle and says why.
    const decision = resolveTimelineResume({
      earliest: "ledger-cursor-0",
      latest: "ledger-cursor-33",
      acknowledged: "ledger-cursor-12",
    });

    expect(decision.outcome).toBe("refused");
    expect(decision.outcome === "refused" ? decision.refusal.code : undefined).toBe(
      "cursor-order-undecidable",
    );
  });

  it("negative control: one readable position is not enough to order the pair", () => {
    // Half a comparison is not a comparison. Without this the rule could read the
    // one position it understood and rank it against a string.
    const decision = resolveTimelineResume({
      earliest: "-1_1723291400000000000",
      latest: LATEST,
      acknowledged: "ledger-cursor-12",
    });

    expect(decision.outcome === "refused" ? decision.refusal.code : undefined).toBe(
      "cursor-order-undecidable",
    );
  });

  it("negative control: an orderable pair of the same shape is decided", () => {
    // Without this the pair above would pass over a rule that refused every
    // acknowledged cursor, which is the version-skew arm swallowing the ordinary one.
    expect(
      resolveTimelineResume({ earliest: EARLIEST, latest: LATEST, acknowledged: ACKNOWLEDGED })
        .outcome,
    ).toBe("resume");
  });
});

describe("an absent floor refuses the whole resume cycle, SDK-locally", () => {
  it("refuses a read whose cursor block carries no earliest position", () => {
    const decision = resolveTimelineResume({ latest: LATEST, acknowledged: ACKNOWLEDGED });

    expect(decision.outcome).toBe("refused");
    const refusal = decision.outcome === "refused" ? decision.refusal : undefined;
    expect(refusal === undefined ? false : isConsoleRefusal(refusal)).toBe(true);
    expect(refusal?.origin).toBe(TIMELINE_RESUME_ORIGIN);
    expect(refusal?.code).toBe("earliest-cursor-absent");
  });

  it("refuses a read that carried no cursor block at all", () => {
    const decision = resolveTimelineResume(undefined);

    expect(decision.outcome).toBe("refused");
    expect(decision.outcome === "refused" ? decision.refusal.code : undefined).toBe(
      "cursors-absent",
    );
  });

  it("refuses a block with no `latest`, which is not a cursor block at all", () => {
    // `latest` is the one required member of the registered shape. A record without
    // it is something else, and reporting it as a skewed responder would name the
    // wrong fact.
    const decision = resolveTimelineResume({ earliest: EARLIEST });

    expect(decision.outcome === "refused" ? decision.refusal.code : undefined).toBe(
      "cursors-absent",
    );
  });

  it("negative control: the complete block is not refused", () => {
    // Without this, a rule that refused everything would pass every case above.
    expect(
      resolveTimelineResume({ earliest: EARLIEST, latest: LATEST, acknowledged: ACKNOWLEDGED })
        .outcome,
    ).not.toBe("refused");
  });
});

describe("the refusal set is closed, in both directions", () => {
  /** Every input that refuses, paired with nothing but its own shape. */
  const REFUSING_READS: readonly unknown[] = [
    undefined,
    { earliest: EARLIEST },
    { latest: LATEST },
    { latest: LATEST, acknowledged: ACKNOWLEDGED },
    { earliest: "not-a-position", latest: LATEST, acknowledged: ACKNOWLEDGED },
  ];

  it("raises every code it declares, and declares every code it raises", () => {
    // The compiler already closes one direction — a refusal reaches its code through
    // a parameter typed by the enumeration, so an unlisted code does not build. This
    // closes the other: a member nothing can raise is a code a surface would have to
    // handle and never see, and it goes stale silently.
    const raised = new Set(
      REFUSING_READS.map((read) => resolveTimelineResume(read)).flatMap((decision) =>
        decision.outcome === "refused" ? [decision.refusal.code] : [],
      ),
    );

    expect([...raised].sort()).toStrictEqual([...TIMELINE_RESUME_REFUSAL_CODES].sort());
  });

  it("negative control: the reads driving that set really do all refuse", () => {
    // Without this the case above would pass over a set built from nothing, since an
    // empty set of raised codes would only fail against a non-empty enumeration.
    expect(REFUSING_READS.length).toBeGreaterThan(0);
    for (const read of REFUSING_READS) {
      expect(resolveTimelineResume(read).outcome).toBe("refused");
    }
  });
});
