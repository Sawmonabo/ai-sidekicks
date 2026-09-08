// One region of the diagnostics page: a heading and whatever answered it.
//
// The page has five regions and each of them is a labelled section wearing the
// family's block chrome. Written once here rather than five times, because the thing
// that makes the page readable is that the regions look identical whatever arrived in
// them — a served banner, an absence, and a refusal all sit in the same frame, so a
// reader comparing regions is comparing answers rather than layouts.
//
// The label is on the section as well as in the heading: an assistive reader landing
// in the middle of this page needs to know which reading it is inside, and a heading
// alone does not answer that.

import type { ReactNode } from "react";

export function DiagnosticsRegion(props: {
  readonly heading: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className="meridian-settings-page__block" aria-label={props.heading}>
      <h3 className="meridian-settings-page__block-title">{props.heading}</h3>
      {props.children}
    </section>
  );
}
