// What a tree had COMMITTED at each frame, recorded before its passive effects ran.
//
// THE DEFECT IT SEES IS ONE COMMITTED FRAME LONG. A component holding a subject-scoped
// read in `useState` and clearing it at the top of its effect clears it FIRST WITHIN
// THE EFFECT — which is one commit after the render that renamed the subject, so that
// commit paints the previous subject's answer under the new subject's name. Asserting
// on the DOM after `rerender` cannot see it: React's `act` flushes the passive effect
// before returning, so the stale frame has already been replaced by the time a case
// looks.
//
// WHY `Profiler` AND NOT A LAYOUT EFFECT IN A SIBLING. A sibling's layout effect runs
// only when the sibling itself re-renders, and the commits this measures are driven by
// state inside the wrapped component — which re-renders that component alone, so a sibling would
// record nothing at all. `Profiler.onRender` is called for every commit of the tree it
// WRAPS, whoever caused it, during the commit phase and before any passive effect. That
// is exactly the set of frames a person could have seen, in order.
//
// `id` IS A PARAMETER because React uses the id to name the tree in a profiling record, so
// each caller passes its own and two recorders in one tree stay distinguishable.
//
// IT READS THE DOCUMENT rather than a container handle, so one recorder serves any tree
// a case renders — and because the container is not initialized yet on the first commit,
// which is the one frame this instrument most needs to see.

import { Profiler, type ReactNode } from "react";

/**
 * Record the committed text of every frame the wrapped tree paints, in order.
 *
 * @param id What React names this tree in a profiling record. One per recorder.
 * @param onFrame Called once per commit with `document.body`'s text at that commit.
 */
export function CommittedFrameRecorder(props: {
  readonly id: string;
  readonly onFrame: (committedText: string) => void;
  readonly children: ReactNode;
}): React.JSX.Element {
  const { onFrame } = props;
  return (
    <Profiler
      id={props.id}
      onRender={() => {
        onFrame(document.body.textContent ?? "");
      }}
    >
      {props.children}
    </Profiler>
  );
}
