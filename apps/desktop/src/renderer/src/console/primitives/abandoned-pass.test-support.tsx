// A render pass React really runs and really never commits, left standing.
//
// The claim every latest-ref case makes is about the WINDOW after a discarded pass:
// the tree on screen is still the committed one, the discarded pass has run every
// component body in it, and what a long-lived callback invokes must still be what the
// committed render supplied. So a case has to be able to assert while the tree is in
// exactly that state.
//
// WHY THIS IS NOT `store/subject-scoped/subject-scoped-drivers.test-support.ts`'s `driveAbandonedPass`.
// That driver answers a different question and ends in a different place: it renders a
// third pass back at the committed subject before it returns, because the holder claims
// it serves are about what the RECOVERED tree reads. A ref written in a render body is
// corrected by that third pass, so every case driven through it would pass on the shape
// this one is written against. Two claims, two drivers — and that module also sits in a
// family ABOVE this one, so its gate could not be borrowed here in any case.
//
// THE SUSPENSION IS A TRANSITION THAT NEVER RESOLVES. A render-phase state update is
// the wrong driver: React answers that one by re-invoking the component and reusing the
// hook cells the pass built, so nothing is thrown away except its output. A transition
// that suspends is a work-in-progress fiber React parks — the committed tree keeps its
// own frame and no fallback is shown — which is the concurrent discard the latest-ref
// shape exists for. Leaving the promise unsettled is what makes it deterministic rather
// than a race against React's retry.

import { act } from "@testing-library/react";
import { startTransition } from "react";

/** Nothing settles it, so the pass that suspends on it never resumes. */
const NEVER_SETTLES: Promise<void> = new Promise<void>(() => undefined);

/**
 * Suspend the tree the moment `suspend` turns true, and render nothing otherwise.
 *
 * A component rather than a bare `throw` in the caller's own body, so the suspension
 * is a sibling of whatever the case is measuring rather than a branch inside it.
 */
export function SuspendsWhenAsked(props: { readonly suspend: boolean }): React.JSX.Element | null {
  if (props.suspend) {
    throw NEVER_SETTLES;
  }
  return null;
}

/**
 * Run `beginAbandonedPass` as a transition, and return with that pass discarded.
 *
 * The caller's callback moves the tree to whatever state it wants abandoned — and
 * must also flip a {@link SuspendsWhenAsked} it renders, or React will commit the pass
 * like any other. Deliberately renders nothing afterwards: the window this leaves the
 * tree in is the subject.
 */
export async function abandonOneRenderPass(beginAbandonedPass: () => void): Promise<void> {
  await act(async () => {
    startTransition(beginAbandonedPass);
  });
}
