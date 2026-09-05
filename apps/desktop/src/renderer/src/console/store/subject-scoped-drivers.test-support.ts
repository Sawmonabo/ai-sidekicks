// How a suite drives the two phases a subject-scoped addressing is held in.
//
// `subject-scoped-holder.ts` mints an addressing during a render and confirms it when
// that render commits, and those are two calls because React decides between them.
// Every suite in this family therefore has to say which of the two it is driving, and
// there are exactly two ways to say it: directly, with no renderer, in the order React
// would; and through React, with a pass that really runs and really never commits.
//
// ONE HOME FOR BOTH, because they are one role — putting a holder into a state a
// claim is about — and because a test file may not import another test file: that
// would make one suite's cases a dependency of another's. The shared walk under
// `test/console/console-source-modules.ts` excludes `.test-support.*` from the
// source-text gates exactly as it excludes tests.
//
// THE ABANDONED PASS IS DRIVEN BY A TRANSITION THAT SUSPENDS AND IS NEVER RESOLVED.
// A render-phase state update is the wrong driver for it: React answers that one by
// re-invoking the component and REUSING the hook cells that pass built, so nothing
// about the pass is thrown away except its output. A transition that suspends is a
// work-in-progress fiber React parks — the tree on screen keeps its own frame, no
// fallback is shown, and a later higher-priority render at another subject supersedes
// it — which is the concurrent discard the substrate is written against. Leaving its
// promise unresolved is what makes the case deterministic rather than a race between
// React's retry and the test's next render.

import { act, render, type RenderResult } from "@testing-library/react";
import { startTransition, type ReactElement } from "react";

import type { SubjectKey, SubjectScopedHolder } from "./subject-scoped-holder.js";

/**
 * Address a holder and confirm it, which is what one committed render does.
 *
 * The React-free door. A suite that called `address` alone would be driving a pass
 * that never reached the screen, and every claim about the visit on screen would be
 * about a proposal instead.
 */
export function visit<TValue>(
  holder: SubjectScopedHolder<TValue>,
  subject: object,
  key: SubjectKey,
  initial: () => TValue,
): void {
  holder.address(subject, key, initial);
  holder.commit(subject, key);
}

/**
 * A promise nothing ever settles, so the pass that suspends on it never resumes.
 *
 * Minted by the CALLER and handed in as a prop: React refuses to treat one minted
 * inside a render body as a suspension it can retry.
 */
export class SuspensionGate {
  #open: (() => void) | undefined;
  public readonly pending: Promise<void>;

  public constructor() {
    this.pending = new Promise<void>((resolve) => {
      this.#open = resolve;
    });
  }

  public open(): void {
    this.#open?.();
  }
}

/**
 * Drive one committed visit, one pass at another subject that is abandoned, and one
 * render back at the visit that committed.
 *
 * The tree is the caller's, so a claim and its negative control run the identical
 * script and differ only in the arrangement under test.
 */
export async function driveAbandonedPass<TSubject extends object>(
  treeAt: (subject: TSubject, suspendOn: Promise<void> | undefined) => ReactElement,
  committed: TSubject,
  abandoned: TSubject,
): Promise<RenderResult> {
  const view = render(treeAt(committed, undefined));
  const gate = new SuspensionGate();
  await act(async () => {
    startTransition(() => {
      view.rerender(treeAt(abandoned, gate.pending));
    });
  });
  await act(async () => {
    view.rerender(treeAt(committed, undefined));
  });
  return view;
}

/**
 * Drive one visit, one pass React DROPS at another subject, and one visit back.
 *
 * The suspension here is resolved rather than parked, which is what makes the pass a
 * DROPPED one rather than an abandoned one: React re-renders from the newest element
 * once the promise settles. The two are different drivers for different claims, and
 * the difference is exactly whether the discarded pass is ever retried.
 */
export async function driveDroppedPass<TSubject extends object>(
  treeAt: (subject: TSubject, suspendOn: Promise<void> | undefined) => ReactElement,
  visited: TSubject,
  dropped: TSubject,
): Promise<RenderResult> {
  const view = render(treeAt(visited, undefined));
  const gate = new SuspensionGate();
  await act(async () => {
    view.rerender(treeAt(dropped, gate.pending));
  });
  await act(async () => {
    gate.open();
    await gate.pending;
    view.rerender(treeAt(visited, undefined));
  });
  return view;
}
