// How a surface holds an act controller, and nothing about the act.
//
// SPLIT FROM THE CLASS ON `subject-scoped-resource.ts`'S OWN SEAM. The class beside
// this one collaborates with a wire call and owns what a prerequisite and an act
// publish; this module collaborates with React's rendering lifecycle and owns when a
// controller is opened and ended. They meet at one object.
//
// THE SEAM IS `useSubjectScopedResource` AND NOT `useMemo`, which is that module's own
// distinction: a controller constructed during a pass React discards is a real object
// with a real read on the wire and real triggers armed, and no effect ever commits to
// end it. The resource seam closes one inside the render that drops it.
//
// AND THE DISPOSAL IS DECLARED ONCE. Three surfaces each carried their own
// `SubjectScopedDisposal` constant naming the same two methods on three classes that
// spelled them identically, which is three places one rule could drift.

import { useCallback, useSyncExternalStore } from "react";

import type { Unsubscribe } from "../core/index.js";
import type { SubjectKey } from "./subject-scoped-holder.js";
import { useSubjectScopedResource, type SubjectScopedDisposal } from "./subject-scoped-resource.js";

/**
 * The lifecycle an act controller offers a surface, and the whole of what this hook
 * needs from one.
 *
 * NAMED AS A CONTRACT RATHER THAN AS THE CLASS, so a family that composes an
 * {@link ActController} inside a controller of its own — forwarding these four
 * members — binds through this same hook instead of writing the binding again. The
 * repos family's three controllers are exactly that shape.
 */
export interface ActControllerSurface<TReading = unknown> {
  /** What the surface renders. Read through `useSyncExternalStore`, never reached into. */
  readonly snapshot: TReading;
  /** Whether this controller has already ended. How the resource seam recognises one. */
  readonly isDisposed: boolean;
  subscribe(sink: (reading: TReading) => void): Unsubscribe;
  dispose(): void;
}

/** What the hook hands back: the controller to act through, and what to render. */
export interface ActControllerBinding<TController extends ActControllerSurface> {
  readonly controller: TController;
  readonly reading: TController["snapshot"];
}

/**
 * Bind one subject's act controller to a surface.
 *
 * The key is the whole of what the controller is scoped to — a session for a roster, a
 * mount for the modes it admits, a workspace AND its execution mode for a root — and a
 * key carrying less than that leaves a controller in place across a rebind, answering
 * the previous subject's question.
 */
export function useActController<TController extends ActControllerSurface>(
  subject: object,
  key: SubjectKey,
  open: () => TController,
): ActControllerBinding<TController> {
  const { value: controller } = useSubjectScopedResource(
    subject,
    key,
    open,
    ACT_CONTROLLER_DISPOSAL,
  );
  const subscribe = useCallback(
    (onReadingChange: () => void) => controller.subscribe(onReadingChange),
    [controller],
  );
  const read = useCallback(() => controller.snapshot, [controller]);
  const reading = useSyncExternalStore(subscribe, read, read);
  return { controller, reading };
}

/** How one controller ends, and how one already ended is recognised. Declared once. */
const ACT_CONTROLLER_DISPOSAL: SubjectScopedDisposal<ActControllerSurface> = {
  dispose: (controller) => {
    controller.dispose();
  },
  isClosed: (controller) => controller.isDisposed,
};
