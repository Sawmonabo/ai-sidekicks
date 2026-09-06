// What a tree had COMMITTED at each frame, recorded before its passive effects ran.
//
// THE DEFECT IT SEES IS ONE COMMITTED FRAME LONG. A surface holding a subject-scoped
// read in `useState` and clearing it at the top of its effect clears it FIRST WITHIN
// THE EFFECT — which is one commit after the render that renamed the subject, so that
// commit paints the previous subject's answer under the new subject's name. Asserting
// on the DOM after `rerender` cannot see it: React's `act` flushes the passive effect
// before returning, so the stale frame has already been replaced by the time a case
// looks.
//
// WHY `Profiler` AND NOT A LAYOUT EFFECT IN A SIBLING. A sibling's layout effect runs
// only when the sibling itself re-renders, and the commits this measures are driven by
// state inside the surface — which re-renders that surface alone, so a sibling would
// record nothing at all. `Profiler.onRender` is called for every commit of the tree it
// WRAPS, whoever caused it, during the commit phase and before any passive effect. That
// is exactly the set of frames a person could have seen, in order.
//
// `id` IS A PARAMETER because two suites in sibling view families each wrote this
// recorder for themselves, and the only thing that differed between the two copies was
// the string they passed React. A component that is one argument away from being shared
// is not two components. React uses the id to name the tree in a profiling record, so
// each caller passes its own and two recorders in one tree stay distinguishable.
//
// IT READS THE DOCUMENT rather than a container handle, so one recorder serves any tree
// a case renders — and because the container is not initialised yet on the first commit,
// which is the one frame this instrument most needs to see.
//
// IN `core/` AND NOT BESIDE EITHER CALLER. Its readers are view families, which are
// siblings of one another, so the lowest family both may reach is the DAG floor — the
// same placement `macrotask-boundary.test-support.ts` records for the settle boundary. It
// imports React, which `core/index.ts`'s header says the family does not: that sentence
// is about what `core/` PUBLISHES and what its production modules depend on, and this is
// a test-tier module the door does not publish and no production module imports, on the
// same footing as the platform timer that helper arms.

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
