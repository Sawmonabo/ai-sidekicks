// The read a strict double-mount REPLAYS, and the round it is replayed against.
//
// React's strict remount runs every committed effect's cleanup and then every setup
// again. The read scope's lifetime is `useSubjectScopedResource`'s, and its hook is
// called above the read effect, so its cleanup — which ABANDONS the scope — runs
// first, and the replacement it publishes arrives one render later. In between, the
// read effect replays against the scope its own render captured: the one that cleanup
// just abandoned.
//
// WHY THAT IS A DEFECT AND NOT MERELY A WASTED CHECK. `read` is the caller's, and a
// growth read ignores the signal it is handed by design — the port answers a promise
// the console cannot recall. So a read put on an already-abandoned round is a request
// nothing can ever stop, for a round that was over before it was made, and the
// replacement scope then makes a second one. What the guard removes is that middle
// request; the two that remain are the strict remount's own double-invoke, which every
// effect in the tree pays and which the third case here holds to one outside it.
//
// THE READING IS TAKEN AT THE MOMENT OF THE CALL, and that is the whole method: a
// count alone cannot tell a read that was live when it was put from one that was
// already over, and it is the second that this file is about.

import { render } from "@testing-library/react";
import { StrictMode, useEffect, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { useReadScope } from "../../store/index.js";
import { createFixture } from "../fixture/call-plane/bridge.test-support.js";
import { PROBE_SESSION_ID } from "../scenario-runtime/scripted-probe.test-support.js";
import { useSettledGrowthRead } from "./read-settlement.js";

/** The port both probes address their state and their read line against. */
const growthPort = createFixture().bridge.growth;

/** What the probe's read would answer with. Narrow on purpose: nothing renders it. */
type ProbeOutcome = { readonly status: "served"; readonly value: number };

interface ReadStartLedgerProps {
  /**
   * One entry per read the probe put, each recording whether the round it was put on
   * was ALREADY over at that moment.
   */
  readonly abortedWhenPut: boolean[];
}

/**
 * A read that never answers, so every case here is about the moment it was PUT.
 *
 * Deliberately ignoring the signal, which is what a growth read does: the fixture port
 * answers a promise, and neither it nor the scripted seam beneath it is listening for
 * an abort. A read that honoured the signal would make the defect invisible.
 */
function neverAnsweringRead(): Promise<ProbeOutcome> {
  return new Promise<ProbeOutcome>(() => undefined);
}

/** The hook under test, with the liveness of every round it reads on recorded. */
function SettledGrowthReadProbe({ abortedWhenPut }: ReadStartLedgerProps): ReactElement {
  useSettledGrowthRead<ProbeOutcome, string>(
    growthPort,
    PROBE_SESSION_ID,
    (_subjectKey, signal) => {
      abortedWhenPut.push(signal.aborted);
      return neverAnsweringRead();
    },
    {
      unsettled: () => "unsettled",
      settled: () => "served",
    },
  );
  return <output />;
}

/**
 * The seam beneath, opened from an effect — the shape the hook above is built on.
 *
 * The real `useReadScope`, not a stand-in: what makes the case above non-vacuous is
 * that this seam really does hand a replayed setup a round that is already over, and
 * only an effect can observe it. `read-cancellation.hook.test.tsx` opens its rounds in
 * a render BODY, which reads the value after the re-mint has landed, so the corpse is
 * invisible from there and that suite is green over the same seam.
 */
function ReadScopeEffectProbe({ abortedWhenPut }: ReadStartLedgerProps): ReactElement {
  const readScope = useReadScope(growthPort, PROBE_SESSION_ID);
  useEffect(() => {
    abortedWhenPut.push(readScope.openRound().signal.aborted);
  }, [readScope]);
  return <output />;
}

describe("useSettledGrowthRead — no read is put on a round that is already over", () => {
  it("puts every read on a live round across React's strict double-mount", () => {
    const abortedWhenPut: boolean[] = [];

    render(
      <StrictMode>
        <SettledGrowthReadProbe abortedWhenPut={abortedWhenPut} />
      </StrictMode>,
    );

    // Two reads, both live when they were put: the mount's own, and the one the
    // replacement scope reads through. The third — the replay against the abandoned
    // scope — is the one that never reaches the port.
    expect(abortedWhenPut).toStrictEqual([false, false]);
  });

  it("negative control: the seam beneath hands the replayed setup a round already over", () => {
    // Without this the case above would hold over a seam that never produced a dead
    // round at all, and the guard it asserts would be checking a condition that cannot
    // occur. This is that condition, measured through the real scope hook.
    const abortedWhenPut: boolean[] = [];

    render(
      <StrictMode>
        <ReadScopeEffectProbe abortedWhenPut={abortedWhenPut} />
      </StrictMode>,
    );

    expect(abortedWhenPut).toStrictEqual([false, true, false]);
  });

  it("negative control: outside strict mode the same probe reads once", () => {
    // What makes the two entries above the remount's own double-invoke rather than a
    // second defect: one mount, one read. A hook that had simply stopped reading would
    // satisfy the first case and fail this one.
    const abortedWhenPut: boolean[] = [];

    render(<SettledGrowthReadProbe abortedWhenPut={abortedWhenPut} />);

    expect(abortedWhenPut).toStrictEqual([false]);
  });
});
