// Records what a subject-keyed read commits across a change of source or subject. The probe logs
// committed values, not render calls: the holder re-addresses during render, and a discarded
// render still ran, so a log written from a render body shows values no commit carried. An
// effect runs once per commit, the frame a person sees and assistive technology reads. Shared by
// every suite that makes this claim about a different read.

import { useEffect } from "react";
import { render } from "@testing-library/react";

/**
 * What a read is addressed at: its source and its subject. `TKey` defaults to `undefined`, the
 * keyless read addressed by its source alone; a keyed read supplies the key type. Both members
 * stay required so a keyed case cannot forget its key.
 */
export interface SubjectReadAddress<TSource extends object, TKey = undefined> {
  readonly source: TSource;
  readonly subject: TKey | undefined;
}

/** Every value a committed render carried, plus the handle a re-address needs. */
export interface ObservedSubjectRead<TSource extends object, TReading, TKey = undefined> {
  /** Oldest first. One entry per COMMIT, never one per render call. */
  readonly committed: readonly TReading[];
  /** Re-render the same probe at another source, another subject, or both. */
  readonly readdress: (next: SubjectReadAddress<TSource, TKey>) => void;
}

/**
 * Drives one read hook through a rendered probe, recording what each commit carried. It uses the
 * real hook, never a stand-in, and a keyless hook goes in unwrapped.
 */
export function observeSubjectRead<TSource extends object, TReading, TKey = undefined>(
  useRead: (source: TSource, subject: TKey | undefined) => TReading,
  address: SubjectReadAddress<TSource, TKey>,
): ObservedSubjectRead<TSource, TReading, TKey> {
  const committed: TReading[] = [];
  const collect = (reading: TReading): void => {
    committed.push(reading);
  };
  const probeAt = (at: SubjectReadAddress<TSource, TKey>): React.JSX.Element => (
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

function SubjectReadProbe<TSource extends object, TReading, TKey>(props: {
  readonly useRead: (source: TSource, subject: TKey | undefined) => TReading;
  readonly address: SubjectReadAddress<TSource, TKey>;
  readonly onCommit: (reading: TReading) => void;
}): React.JSX.Element {
  const reading = props.useRead(props.address.source, props.address.subject);
  useEffect(() => {
    props.onCommit(reading);
  });
  return <></>;
}
