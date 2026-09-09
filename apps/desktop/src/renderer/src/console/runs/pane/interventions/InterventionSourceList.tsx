// One of the history's two lists, under the name of where its rows came from.
//
// WHY THE NAME IS ON SCREEN AND NOT ONLY IN THE ACCESSIBLE TREE. The history draws
// the daemon's durable record and this window's own dispatches as two lists, and the
// same intervention can legitimately appear in both — from two sides, carrying two
// different things. A reader who cannot see which list is which reads that as one
// intervention listed twice, which is a defect in what the surface says rather than
// in what it holds. So the caption is prose, and the list takes it as its accessible
// name rather than carrying a second label of its own.
//
// Shared by both halves on the second use: two captions written into two components
// would be two places for one vocabulary to drift.

import { useId } from "react";

/** One captioned list of interventions. */
export function InterventionSourceList(props: {
  /** Where these rows came from, in the console's own words. */
  readonly caption: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  // The caption is the list's accessible name, so it is announced once rather than
  // as a heading beside a label that repeats it.
  const captionId = useId();
  return (
    <div className="meridian-interventions__source">
      <p className="meridian-interventions__source-name" id={captionId}>
        {props.caption}
      </p>
      <ol className="meridian-interventions__rows" aria-labelledby={captionId}>
        {props.children}
      </ol>
    </div>
  );
}
