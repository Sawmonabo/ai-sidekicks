// What a tree had committed at each frame, recorded before its passive effects ran.
//
// The defect it sees is one committed frame long. A component holding a subject-scoped read in
// `useState` and clearing it at the top of its effect clears it one commit after the render that
// renamed the subject, so that commit paints the previous subject's answer under the new name.
// The DOM after `rerender` cannot show it: React's `act` flushes the passive effect before
// returning.
//
// `Profiler` rather than a layout effect in a sibling, because a sibling's layout effect runs
// only when the sibling re-renders, and these commits are driven by state inside the wrapped
// component. `Profiler.onRender` fires for every commit of the tree it wraps, whoever caused it,
// during the commit phase and before any passive effect: exactly the frames a person could see.
//
// `id` is a parameter because React uses it to name the tree in a profiling record, so two
// recorders in one tree stay distinguishable. The recorder reads the document rather than a
// container handle, so it serves any tree a case renders and works on the first commit, when the
// container is not initialized yet.

import { Profiler, type ReactNode } from "react";

/**
 * Records the committed text of every frame the wrapped tree paints, in order.
 *
 * `id` names this tree in React's profiling record, one per recorder; `onFrame` is called once
 * per commit with `document.body`'s text at that commit.
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
