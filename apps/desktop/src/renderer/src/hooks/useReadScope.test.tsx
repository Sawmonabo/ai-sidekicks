// A pane's read line ends with the render that owned it, asserted both ways.
//
// A pane that unmounts abandons its reads, and a pane re-addressed at a new subject abandons
// the reads taken against the old one. Both are claims about the signal the read carries, so
// the seams below can stop working; that the promise is ignored was already true.
//
// Every case first asserts the line is live while the pane is on screen: a hook that handed
// out a born-aborted signal would otherwise satisfy "aborted after unmount". That pairing is
// the negative control.
//
// The lifetime machinery (discarded pass, double-mount corpse, terminal disposal) is
// `subject-scoped/useSubjectScopedResource.ts`'s and is asserted in its own suites. Here the
// claim is that a read scope is wired to it correctly: the disposal is the terminal arm, and
// the re-mint a double mount forces produces a line a returning pane can read through.

import { render } from "@testing-library/react";
import { type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { useReadScope } from "./useReadScope.js";
import { type ReadRound } from "#renderer/lib/reads/scope.js";
import {
  SUBJECT_ONE,
  SUBJECT_TWO,
  type NamedFixtureSubject,
} from "#test/helpers/subject-fixtures.js";

interface ReadLineProbeProps {
  readonly subject: NamedFixtureSubject;
  readonly subjectKey: string;
  /** Every round this probe opened, in the order its renders opened them. */
  readonly rounds: ReadRound[];
}

/**
 * A component that opens one round per render, as a pane's read effect would.
 *
 * Opening in the render body rather than an effect makes the round observable on the pass
 * that produced it, so a case can name "the round the first addressing opened".
 */
function ReadLineProbe({ subject, subjectKey, rounds }: ReadLineProbeProps): ReactElement {
  const scope = useReadScope(subject, subjectKey);
  rounds.push(scope.openRound());
  return <span data-testid="read-line">{subjectKey}</span>;
}

/** The newest round a probe opened; a failure names which reading was taken. */
function newestRound(rounds: readonly ReadRound[]): ReadRound {
  const round = rounds.at(-1);
  if (round === undefined) {
    throw new Error("the probe opened no round, so there is nothing to assert about");
  }
  return round;
}

describe("useReadScope — the line ends with the render that owned it", () => {
  it("abandons the round when the pane unmounts", () => {
    const rounds: ReadRound[] = [];
    const view = render(<ReadLineProbe subject={SUBJECT_ONE} subjectKey="alpha" rounds={rounds} />);
    const mountedRound = newestRound(rounds);

    // The control: while the pane is on screen the line is live on both readings.
    expect(mountedRound.signal.aborted).toBe(false);
    expect(mountedRound.isCurrent).toBe(true);

    view.unmount();

    expect(mountedRound.signal.aborted).toBe(true);
    expect(mountedRound.isCurrent).toBe(false);
    expect(mountedRound.settle(() => undefined)).toBe(false);
  });

  it("abandons the old subject's round when the pane is re-addressed", () => {
    const rounds: ReadRound[] = [];
    const view = render(<ReadLineProbe subject={SUBJECT_ONE} subjectKey="alpha" rounds={rounds} />);
    const firstSubjectRound = newestRound(rounds);
    expect(firstSubjectRound.signal.aborted).toBe(false);

    view.rerender(<ReadLineProbe subject={SUBJECT_TWO} subjectKey="alpha" rounds={rounds} />);

    const secondSubjectRound = newestRound(rounds);
    expect(secondSubjectRound).not.toBe(firstSubjectRound);
    expect(firstSubjectRound.signal.aborted).toBe(true);
    // The new subject reads through a live line: abandoning the old one must not leave the
    // pane holding a closed scope, which is why the disposal carries a reading beside it.
    expect(secondSubjectRound.signal.aborted).toBe(false);
    expect(secondSubjectRound.isCurrent).toBe(true);

    view.unmount();
  });
});
