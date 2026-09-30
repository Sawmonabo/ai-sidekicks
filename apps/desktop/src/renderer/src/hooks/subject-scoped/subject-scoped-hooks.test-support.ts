// How a suite drives, through React, a pass that really runs and never commits.
//
// `subject-scoped-holder.ts` mints an addressing during a render and confirms it when that
// render commits, so the claims about an uncommitted addressing need a pass React ran and
// threw away.
//
// The abandoned pass is driven by a transition that suspends and is never resolved. A
// render-phase state update is the wrong driver: React answers it by re-invoking the
// component and reusing the hook cells that pass built, so nothing is thrown away but its
// output. A suspending transition is a work-in-progress fiber React parks: the tree on
// screen keeps its own frame, no fallback shows, and a later higher-priority render at
// another subject supersedes it. Leaving the promise unresolved makes the case
// deterministic rather than a race between React's retry and the test's next render.

import { act, render, type RenderResult } from "@testing-library/react";
import { startTransition, type ReactElement } from "react";

/**
 * Drive one committed visit, one pass at another subject that is abandoned, and one render
 * back at the visit that committed.
 *
 * The tree is the caller's, so a claim and its negative control run the identical script and
 * differ only in the arrangement under test.
 */
export async function driveAbandonedPass<TSubject extends object>(
  treeAt: (subject: TSubject, suspendOn: Promise<void> | undefined) => ReactElement,
  committed: TSubject,
  abandoned: TSubject,
): Promise<RenderResult> {
  const view = render(treeAt(committed, undefined));
  // Nothing ever settles it, so the pass that suspends on it never resumes. It is minted here and
  // handed in as a prop: React refuses to retry a suspension minted inside a render body.
  const neverSettles = new Promise<void>(() => undefined);
  await act(async () => {
    startTransition(() => {
      view.rerender(treeAt(abandoned, neverSettles));
    });
  });
  await act(async () => {
    view.rerender(treeAt(committed, undefined));
  });
  return view;
}
