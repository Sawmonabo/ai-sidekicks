// The resume rule, driven directly.
//
// Every case here is the contract's own sentence turned into an assertion, and every
// clean result has the negative control the rule needs to mean anything: a predicate
// that answered "resume from earliest" for every input would satisfy half of these
// on its own, and one that refused everything would satisfy the other half.
//
// The suite also pins what this module DOES NOT do. It orders no cursors, so a pair
// a retired leading-integer decoder would have called a loss is resumed from — and
// the negative control drives that with cursors of the shape actually on the wire.

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

describe("no lost-event arm exists, because no ordering is published", () => {
  it("resumes from an acknowledged cursor that a leading-integer scan would rank below the floor", () => {
    // The retired decoder read a leading integer run and called 120 < 900 a loss.
    // The contract publishes no `decode`, and `earliest` is the V1-constant floor
    // nothing acknowledged can be below — so this pair resumes, and a rule that
    // reset here would be discarding a live projection on an invented ordering.
    const decision = resolveTimelineResume({
      earliest: "900_1723291400000000000",
      latest: "1200_1723291500000000000",
      acknowledged: "120_1723200000000000000",
    });

    expect(decision.outcome).toBe("resume");
    expect(decision.outcome === "resume" ? decision.fromCursor : undefined).toBe(
      "120_1723200000000000000",
    );
  });

  it("negative control: two arbitrary opaque cursors are resumed from, never reset", () => {
    // The cursors on the wire TODAY are UUIDs the client SDK synthesizes from an
    // event id, so a leading-integer scan ordered them by whichever hex digit each
    // happened to start with — one pair refusing, the next resetting, on nothing.
    // Every one of these resumes from its own acknowledged cursor, unchanged.
    const opaquePairs = [
      ["4f2ab8c1-6d3e-4a11-9f70-1c2d3e4f5a6b", "0b9c7d21-8e4f-4c22-8a31-9d8e7f6a5b4c"],
      ["0b9c7d21-8e4f-4c22-8a31-9d8e7f6a5b4c", "4f2ab8c1-6d3e-4a11-9f70-1c2d3e4f5a6b"],
      ["ledger-cursor-0", "ledger-cursor-12"],
      ["ledger-cursor-12", "ledger-cursor-0"],
      ["-1_1723291400000000000", "ac9f1e77-2b40-4d55-b6c8-0e1f2a3b4c5d"],
    ] as const;

    for (const [earliest, acknowledged] of opaquePairs) {
      const decision = resolveTimelineResume({ earliest, latest: LATEST, acknowledged });

      expect(decision.outcome).toBe("resume");
      expect(decision.outcome === "resume" ? decision.fromCursor : undefined).toBe(acknowledged);
    }
  });

  it("negative control: the floor is still taken when nothing was acknowledged", () => {
    // Without this, a rule that answered `acknowledged` for every input would pass
    // every case above — including the first read, which has none to answer with.
    const decision = resolveTimelineResume({ earliest: EARLIEST, latest: LATEST });

    expect(decision.outcome === "resume" ? decision.fromCursor : undefined).toBe(EARLIEST);
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
