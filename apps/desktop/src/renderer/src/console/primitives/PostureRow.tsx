// The row density of one execution posture: the line and the root count open, the
// facts one click away.
//
// ITS OWN MODULE BECAUSE A `.tsx` DECLARES ONE COMPONENT. It was a private second
// component inside `ExecutionPostureChip.tsx`, which is the one file in this family
// that decides WHICH density to render; splitting leaves that file with the choice
// and gives this one the disclosure, and neither has to be read to understand the
// other. It is deliberately absent from the family door: its only reader is its
// sibling, and a door line no other family imports is a dead export.
//
// THE FACTS ARE RENDERED ONLY WHILE OPEN, the shape `PathEnumeration` beside this
// file takes and for the same reason: a closed `<details>` hides its children
// without stopping React from building them, so a list of runs would pay for one
// definition list per row to show nobody.
//
// AND THE COUNT IN THE SUMMARY IS WHAT MAKES THE CLOSED STATE HONEST. An empty
// `writableRoots` means two opposite things — nothing writable under a sandboxed
// mode, no OS-enforced write constraint under `trusted` — so the closed summary
// carries the count beside the mode and the two are never apart at any density.
// Opening the row is what expands the count into the paths, never what reveals that
// there were any.

import { useState } from "react";
import { type ExecutionPosture as WireExecutionPosture } from "@ai-sidekicks/contracts";

import { DerivedFigure } from "./DerivedFigure.js";
import { PostureFacts } from "./PostureFacts.js";
import { POSTURE_ENFORCEMENT_CAVEAT } from "./posture-copy.js";
import type { PostureReading } from "./posture-reading.js";
import { formatCount } from "./wire-figures.js";

/** The row presentation. `children` is the chip line its sibling composed. */
export function PostureRow(props: {
  readonly posture: WireExecutionPosture;
  readonly reading: PostureReading;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const rootCount = props.posture.writableRoots.length;
  return (
    <details
      className={`meridian-posture meridian-posture--row meridian-posture--${props.reading}`}
      onToggle={(event) => {
        setIsOpen(event.currentTarget.open);
      }}
    >
      <summary className="meridian-posture__summary">
        {props.children}
        <DerivedFigure text={writableRootSummary(rootCount, props.posture.mode)} />
      </summary>
      {isOpen ? (
        <>
          <PostureFacts posture={props.posture} />
          <p className="meridian-posture__caveat">{POSTURE_ENFORCEMENT_CAVEAT}</p>
        </>
      ) : null}
    </details>
  );
}

/**
 * What the closed summary says about the writable roots.
 *
 * The zero case is TWO sentences and not one, because zero means two opposite things
 * and the mode is what tells them apart: under `trusted` no writable root was
 * recorded, which is a gap in the record; under either sandboxed mode nothing was
 * writable, which is a boundary that held.
 */
function writableRootSummary(rootCount: number, mode: WireExecutionPosture["mode"]): string {
  if (rootCount > 0) {
    return `${formatCount(rootCount)} writable`;
  }
  return mode === "trusted" ? "no writable root recorded" : "nothing writable";
}
