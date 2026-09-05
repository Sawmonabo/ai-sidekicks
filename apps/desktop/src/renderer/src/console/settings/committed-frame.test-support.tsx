// What a tree had COMMITTED at each frame, recorded before its passive effects ran.
//
// The defect this exists to catch is one committed frame long. A page holding a
// session-scoped read in `useState` and clearing it at the top of its effect clears
// it FIRST WITHIN THE EFFECT — which is one commit after the render that renamed the
// subject, so that commit paints the previous session's answer under the new
// session's name. Asserting on the DOM after `rerender` cannot see it: React's `act`
// flushes the passive effect before returning, so the stale frame has already been
// replaced by the time a case looks.
//
// WHY `Profiler` AND NOT A LAYOUT EFFECT IN A SIBLING. A sibling's layout effect runs
// only when the sibling itself re-renders, and the commits this measures are driven
// by state inside the page — which re-renders the page alone. `Profiler.onRender` is
// called for every commit of the tree it WRAPS, whoever caused it, during the commit
// phase and before any passive effect. That is exactly the set of frames a person
// could have seen, in order.
//
// It reads the document rather than a container handle so one recorder serves any
// tree a case renders.

import { Profiler, type ReactNode } from "react";

/** Records the committed text of every frame the wrapped tree paints, in order. */
export function CommittedFrameRecorder(props: {
  readonly onFrame: (committedText: string) => void;
  readonly children: ReactNode;
}): React.JSX.Element {
  const { onFrame } = props;
  return (
    <Profiler
      id="committed-frames"
      onRender={() => {
        onFrame(document.body.textContent ?? "");
      }}
    >
      {props.children}
    </Profiler>
  );
}
