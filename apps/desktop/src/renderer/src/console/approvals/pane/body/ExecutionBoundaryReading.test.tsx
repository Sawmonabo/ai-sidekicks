// Four phases of one read, and the empty message that belongs to exactly one of them.
//
// The section derives its rows from the approval projection, and `partitionRecords`
// hands it an empty list for a read that has not been put, one still in flight, and
// one that refused — as well as for one that answered with nothing. A section keyed
// on the list alone therefore told an operator "no decision is waiting, so no run's
// boundary is in question" during an outage: an assurance nobody had established.
// Each case below is the one that fails when two of the four collapse.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../../../core/index.js";
import { type ApprovalRecord } from "../../../bridge/index.js";
import { type ReadPhase } from "../approvals-reader.js";
import { type AddressedRunPosture } from "../posture/addressed-run-postures.js";
import { ExecutionBoundaryReading } from "./ExecutionBoundaryReading.js";

const EMPTY_MESSAGE = "No decision is waiting, so no run's boundary is in question.";

const ANSWERED_EMPTY: ReadPhase<ApprovalRecord> = {
  status: "answered",
  rows: [],
  unreadableCount: 0,
};

// One addressed run whose boundary the store carries no stamp for. An unstamped run
// is CARRIED rather than dropped — `addressed-run-postures.ts` states why — so it is
// the shortest fixture that proves a row rendered, and the chip's own arms are
// `ExecutionPostureChip.test.tsx`'s subject rather than this file's.
const ADDRESSED: readonly AddressedRunPosture[] = [
  { runId: "019b7a33-3300-740e-8110-d1a4c1150511", posture: undefined },
];

describe("the execution boundary renders its read's phase", () => {
  it("says nobody asked before the read is put", () => {
    render(<ExecutionBoundaryReading phase={{ status: "not-checked" }} addressed={[]} />);
    expect(
      screen.getByText("The console has not asked which decisions are waiting."),
    ).not.toBeNull();
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
  });

  it("says the read is in flight rather than that nothing is waiting", () => {
    render(<ExecutionBoundaryReading phase={{ status: "loading" }} addressed={[]} />);
    expect(screen.getByText("Reading which decisions are waiting.")).not.toBeNull();
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
  });

  it("renders the daemon's own words when the read refused", () => {
    // The outage case. An empty list here is the absence of an answer, not an answer,
    // and reporting it as one is a false assurance during exactly the moment an
    // operator most needs to know a run boundary may be relevant.
    render(
      <ExecutionBoundaryReading
        phase={{
          status: "refused",
          refusal: refuse("approvals", "session.not_found", "No session with that id is open."),
        }}
        addressed={[]}
      />,
    );
    expect(screen.getByText("session.not_found")).not.toBeNull();
    expect(screen.getByText("No session with that id is open.")).not.toBeNull();
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
  });

  it("keeps the empty message for an answered read with nothing waiting", () => {
    render(<ExecutionBoundaryReading phase={ANSWERED_EMPTY} addressed={[]} />);
    expect(screen.getByText(EMPTY_MESSAGE)).not.toBeNull();
  });

  it("negative control: an answered read with an addressed run renders its boundary", () => {
    // Without this the four cases above would pass over a component that rendered an
    // absence for every phase there is.
    render(
      <ExecutionBoundaryReading
        phase={{ status: "answered", rows: [], unreadableCount: 0 }}
        addressed={ADDRESSED}
      />,
    );
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
    expect(screen.getByText("019b7a33-3300-740e-8110-d1a4c1150511")).not.toBeNull();
  });
});
