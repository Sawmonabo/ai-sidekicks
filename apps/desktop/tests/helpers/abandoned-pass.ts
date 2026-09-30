// A render pass React really runs and really never commits, left standing.
//
// Every latest-ref case claims something about the window after a discarded pass: the tree on
// screen is still the committed one, the discarded pass ran every component body in it, and what
// a long-lived callback invokes must still be what the committed render supplied. A case has to
// assert while the tree is in exactly that state.
//
// This is not `hooks/subject-scoped/subject-scoped-hooks.test-support.ts`'s `driveAbandonedPass`,
// which renders a third pass back at the committed subject before returning because its claims
// are about the recovered tree. A ref written in a render body is corrected by that third pass,
// so cases driven through it would pass on the shape this one is written against.
//
// The suspension is a transition that never resolves. A render-phase state update is the wrong
// driver: React re-invokes the component and reuses the hook cells the pass built, discarding
// only its output. A suspended transition is a work-in-progress fiber React parks: the committed
// tree keeps its frame and no fallback shows, which is the concurrent discard the latest-ref
// shape exists for. Leaving the promise unsettled makes it deterministic rather than a race
// against React's retry.

import { act } from "@testing-library/react";
import { startTransition } from "react";

/** Nothing settles it, so the pass that suspends on it never resumes. */
export const NEVER_SETTLES: Promise<never> = new Promise<never>(() => undefined);

/**
 * Suspends the tree the moment `suspend` turns true, and renders nothing otherwise.
 *
 * A component rather than a bare `throw` in the caller's body, so the suspension is a sibling of
 * whatever the case measures rather than a branch inside it.
 */
export function SuspendsWhenAsked(props: { readonly suspend: boolean }): React.JSX.Element | null {
  if (props.suspend) {
    throw NEVER_SETTLES;
  }
  return null;
}

/**
 * Runs `beginAbandonedPass` as a transition and returns with that pass discarded.
 *
 * The callback moves the tree to the state to abandon and must also flip a
 * {@link SuspendsWhenAsked} it renders, or React commits the pass like any other. Nothing is
 * rendered afterwards: the window this leaves the tree in is the subject.
 */
export async function abandonOneRenderPass(beginAbandonedPass: () => void): Promise<void> {
  await act(async () => {
    startTransition(beginAbandonedPass);
  });
}
