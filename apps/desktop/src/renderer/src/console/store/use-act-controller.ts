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
// AND THE DISPOSAL IS DECLARED ONCE, for every subject-scoped controller in the
// console and not only for the ones this hook binds. Four surfaces each carried their
// own `SubjectScopedDisposal` constant naming the same two methods on classes that
// spelled them identically, which is four places one rule could drift — so the
// constant is typed on {@link DisposableController}, the whole of what disposing one
// requires, and the fourth surface (the repos family's root-disposal controller,
// which publishes into a host rather than off a snapshot and so binds through
// `useSubjectScopedResource` directly) takes the same one.

import { useCallback, useSyncExternalStore } from "react";

import type { Unsubscribe } from "../core/index.js";
import type { SubjectKey } from "./subject-scoped-holder.js";
import { useSubjectScopedResource, type SubjectScopedDisposal } from "./subject-scoped-resource.js";

/**
 * The lifecycle an act controller offers a surface, and the whole of what this hook
 * needs from one.
 *
 * NAMED AS A CONTRACT RATHER THAN AS THE CLASS, so a controller that reaches an
 * `ActController` through `act-controller-base.ts` — or holds one directly, forwarding
 * these four members — binds through this same hook instead of writing the binding
 * again. The repos family's three controllers extend that base and are exactly this
 * shape without naming it.
 */
export interface ActControllerSurface<TReading = unknown> extends DisposableController {
  /** What the surface renders. Read through `useSyncExternalStore`, never reached into. */
  readonly snapshot: TReading;
  subscribe(sink: (reading: TReading) => void): Unsubscribe;
}

/**
 * How any subject-scoped controller ends, and the whole of what {@link CONTROLLER_DISPOSAL}
 * needs from one.
 *
 * NARROWER THAN {@link ActControllerSurface} ON PURPOSE. A controller that publishes
 * into a host rather than off a snapshot of its own has no reading to subscribe to and
 * still has exactly this lifetime, so typing the disposal on the pair it actually
 * calls is what lets one constant serve both shapes.
 */
export interface DisposableController {
  /** Whether this controller has already ended. How the resource seam recognises one. */
  readonly isDisposed: boolean;
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
  const { value: controller } = useSubjectScopedResource(subject, key, open, CONTROLLER_DISPOSAL);
  const subscribe = useCallback(
    (onReadingChange: () => void) => controller.subscribe(onReadingChange),
    [controller],
  );
  const read = useCallback(() => controller.snapshot, [controller]);
  const reading = useSyncExternalStore(subscribe, read, read);
  return { controller, reading };
}

/** How one controller ends, and how one already ended is recognised. Declared once. */
export const CONTROLLER_DISPOSAL: SubjectScopedDisposal<DisposableController> = {
  dispose: (controller) => {
    controller.dispose();
  },
  isClosed: (controller) => controller.isDisposed,
};
