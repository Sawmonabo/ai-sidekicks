// A pane's read line ends with the render that owned it — asserted, both ways.
//
// The two facts the decision to build this rests on are the two cases here: a pane
// that UNMOUNTS abandons its reads, and a pane RE-ADDRESSED at a new subject abandons
// the reads taken against the old one. Neither is a claim about a promise being
// ignored — that was already true — but about the signal the read is carrying, which
// is what lets the seams below it stop working.
//
// EVERY CASE IS PAIRED WITH THE READING TAKEN BEFORE THE ENDING. A hook that handed
// out a born-aborted signal would satisfy "the signal is aborted after unmount"
// perfectly, so each case first asserts the line is LIVE while the surface is on
// screen. That pairing is the negative control, and it is why the assertions are two
// and not one.
//
// The lifetime machinery underneath — the discarded pass, the double-mount corpse,
// the disposal that is terminal — is `subject-scoped-resource.ts`'s and is asserted
// in its own suites. What is asserted here is that a read scope is wired to it
// correctly: that the disposal really is the terminal arm, and that the re-mint the
// double mount forces produces a line a returning surface can read through.

import { render } from "@testing-library/react";
import { type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { useReadScope, type ReadRound } from "./read-cancellation.js";
import {
  SUBJECT_ONE,
  SUBJECT_TWO,
  type NamedFixtureSubject,
} from "./subject-fixtures.test-support.js";

interface ReadLineProbeProps {
  readonly subject: NamedFixtureSubject;
  readonly subjectKey: string;
  /** Every round this probe opened, in the order its renders opened them. */
  readonly rounds: ReadRound[];
}

/**
 * A surface that opens one round per render, as a pane's read effect would.
 *
 * Opening in the render body rather than in an effect is deliberate for a probe: it
 * makes the round observable on the pass that produced it, which is what lets a case
 * name "the round the first addressing opened" without reaching into an effect.
 */
function ReadLineProbe({ subject, subjectKey, rounds }: ReadLineProbeProps): ReactElement {
  const scope = useReadScope(subject, subjectKey);
  rounds.push(scope.openRound());
  return <span data-testid="read-line">{subjectKey}</span>;
}

/** The newest round a probe opened. Named so a failure says which reading was taken. */
function newestRound(rounds: readonly ReadRound[]): ReadRound {
  const round = rounds.at(-1);
  if (round === undefined) {
    throw new Error("the probe opened no round, so there is nothing to assert about");
  }
  return round;
}

describe("useReadScope — the line ends with the render that owned it", () => {
  it("abandons the round when the surface unmounts", () => {
    const rounds: ReadRound[] = [];
    const view = render(<ReadLineProbe subject={SUBJECT_ONE} subjectKey="alpha" rounds={rounds} />);
    const mountedRound = newestRound(rounds);

    // The control: while the surface is on screen the line is live on both readings.
    expect(mountedRound.signal.aborted).toBe(false);
    expect(mountedRound.isCurrent).toBe(true);

    view.unmount();

    expect(mountedRound.signal.aborted).toBe(true);
    expect(mountedRound.isCurrent).toBe(false);
    expect(mountedRound.settle(() => undefined)).toBe(false);
  });

  it("abandons the old subject's round when the surface is re-addressed", () => {
    const rounds: ReadRound[] = [];
    const view = render(<ReadLineProbe subject={SUBJECT_ONE} subjectKey="alpha" rounds={rounds} />);
    const firstSubjectRound = newestRound(rounds);
    expect(firstSubjectRound.signal.aborted).toBe(false);

    view.rerender(<ReadLineProbe subject={SUBJECT_TWO} subjectKey="alpha" rounds={rounds} />);

    const secondSubjectRound = newestRound(rounds);
    expect(secondSubjectRound).not.toBe(firstSubjectRound);
    expect(firstSubjectRound.signal.aborted).toBe(true);
    // The new subject reads through a LIVE line: abandoning the old one must not
    // leave the surface holding a corpse, which is the whole reason the disposal
    // carries a reading beside it.
    expect(secondSubjectRound.signal.aborted).toBe(false);
    expect(secondSubjectRound.isCurrent).toBe(true);

    view.unmount();
  });

  it("abandons the old key's round when only the key moves", () => {
    const rounds: ReadRound[] = [];
    const view = render(<ReadLineProbe subject={SUBJECT_ONE} subjectKey="alpha" rounds={rounds} />);
    const firstKeyRound = newestRound(rounds);
    expect(firstKeyRound.signal.aborted).toBe(false);

    view.rerender(<ReadLineProbe subject={SUBJECT_ONE} subjectKey="beta" rounds={rounds} />);

    expect(firstKeyRound.signal.aborted).toBe(true);
    expect(newestRound(rounds).signal.aborted).toBe(false);

    view.unmount();
  });

  it("keeps one line across a render that moved nothing", () => {
    const rounds: ReadRound[] = [];
    const view = render(<ReadLineProbe subject={SUBJECT_ONE} subjectKey="alpha" rounds={rounds} />);
    const beforeRerender = newestRound(rounds);

    view.rerender(<ReadLineProbe subject={SUBJECT_ONE} subjectKey="alpha" rounds={rounds} />);

    // The round supersedes, because a second read opened; the LINE did not end, which
    // is what a re-render at the same addressing has to mean. A hook that minted a
    // fresh scope per render would abandon a read that nothing replaced.
    const afterRerender = newestRound(rounds);
    expect(afterRerender.signal.aborted).toBe(false);
    expect(beforeRerender.signal.aborted).toBe(true);

    view.unmount();
    expect(afterRerender.signal.aborted).toBe(true);
  });
});
