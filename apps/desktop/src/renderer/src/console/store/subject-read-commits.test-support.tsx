// What a subject-keyed read COMMITS, recorded across a change of source or subject.
//
// THE PROBE RECORDS COMMITTED STATES AND NOT RENDER CALLS, which is the difference the
// mechanism turns on. `subject-scoped-holder.ts` re-addresses DURING the render, and a
// render React discards still ran — so a log written from a render body shows a value
// no commit ever carried, under a correct holder as readily as under a broken one, and
// therefore proves nothing about what a person saw. An effect runs once per COMMIT,
// which is exactly the frame a surface paints and assistive technology reads.
//
// WHY IT IS HERE RATHER THAN IN EACH SUITE. Three suites make the same claim about
// three different reads — the definitions directory, the runs directory, and the run
// snapshot — and the claim is about the commit boundary rather than about any one of
// their state shapes. `apps/desktop/AGENTS.md` hoists a helper on its second use; this
// is its third, and it sits beside the seed rule those three reads share.

import { useEffect } from "react";
import { render } from "@testing-library/react";

/** What a read is addressed at: the source it is put through, and its subject. */
export interface SubjectReadAddress<TSource extends object> {
  readonly source: TSource;
  readonly subject: string | undefined;
}

/** Every value a committed render carried, plus the handle a re-address needs. */
export interface ObservedSubjectRead<TSource extends object, TReading> {
  /** Oldest first. One entry per COMMIT, never one per render call. */
  readonly committed: readonly TReading[];
  /** Re-render the same probe at another source, another subject, or both. */
  readonly readdress: (next: SubjectReadAddress<TSource>) => void;
}

function SubjectReadProbe<TSource extends object, TReading>(props: {
  readonly useRead: (source: TSource, subject: string | undefined) => TReading;
  readonly address: SubjectReadAddress<TSource>;
  readonly onCommit: (reading: TReading) => void;
}): React.JSX.Element {
  const reading = props.useRead(props.address.source, props.address.subject);
  useEffect(() => {
    props.onCommit(reading);
  });
  return <></>;
}

/**
 * Drive one read hook through a rendered probe, recording what each commit carried.
 *
 * The REAL hook, always: a probe that called a stand-in would be measuring a closure
 * rather than the render-time re-addressing, which is the whole mechanism.
 */
export function observeSubjectRead<TSource extends object, TReading>(
  useRead: (source: TSource, subject: string | undefined) => TReading,
  address: SubjectReadAddress<TSource>,
): ObservedSubjectRead<TSource, TReading> {
  const committed: TReading[] = [];
  const collect = (reading: TReading): void => {
    committed.push(reading);
  };
  const probeAt = (at: SubjectReadAddress<TSource>): React.JSX.Element => (
    <SubjectReadProbe useRead={useRead} address={at} onCommit={collect} />
  );
  const view = render(probeAt(address));
  return {
    committed,
    readdress: (next) => {
      view.rerender(probeAt(next));
    },
  };
}

/** The last value a commit carried, for a case whose claim is about where it ended. */
export function latestCommitted<TReading>(committed: readonly TReading[]): TReading {
  const reading = committed.at(-1);
  if (reading === undefined) {
    throw new Error("the probe never committed a render, so there is nothing to read");
  }
  return reading;
}
