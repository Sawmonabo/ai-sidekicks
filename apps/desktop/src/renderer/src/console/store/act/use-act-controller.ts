// How a surface holds an act controller, and nothing about the act.
//
// SPLIT FROM THE CLASSES ON `store/subject-scoped/subject-scoped-resource.ts`'S OWN SEAM.
// The classes beside this one collaborate with a wire call and own what an act and its
// prerequisite publish; this module collaborates with React's rendering lifecycle and
// owns when a controller is opened and ended. They meet at one object.
//
// THE SEAM IS `useSubjectScopedResource` AND NOT `useMemo`, which is that module's own
// distinction: a controller constructed during a pass React discards is a real object
// with real triggers armed, and no effect ever commits to end it. The resource seam
// closes one inside the render that drops it.
//
// TWO HOOKS, ONE PER KIND OF CONTROLLER. An act with no prerequisite arms nothing on a
// session store, so it binds by subject and key alone. A controller that asks first arms
// its refresh triggers on a store, and binds through the second hook, which also rebinds
// it when that store is replaced under an unchanged key.
//
// AND THE DISPOSAL IS DECLARED ONCE, for every subject-scoped resource in the console
// that ends the ordinary way and not only for the ones these hooks bind.

import { useCallback, useSyncExternalStore } from "react";

import type { Unsubscribe } from "@renderer/lib/emitter.js";
import {
  useSessionStoreRebind,
  type SessionStoreScoped,
} from "@renderer/features/repos/acts/hooks/useSessionStoreRebind.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import {
  useSubjectScopedResource,
  type SubjectScopedDisposal,
} from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SubjectKey } from "@renderer/lib/subject-scoped/subject-scoped-holder.js";

/**
 * The lifecycle an act controller offers a surface, and the whole of what these hooks
 * need from one.
 *
 * NAMED AS A CONTRACT RATHER THAN AS A CLASS, so an `ActController`, an
 * `ActSurfaceController`, and anything that holds one and offers these members bind
 * through the same hooks.
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
  /** Whether this controller has already ended. How the resource seam recognizes one. */
  readonly isDisposed: boolean;
  dispose(): void;
}

/** What a hook hands back: the controller to act through, and what to render. */
export interface ActControllerBinding<TController extends ActControllerSurface> {
  readonly controller: TController;
  readonly reading: TController["snapshot"];
}

/**
 * Bind one subject's act controller to a surface.
 *
 * The key is the whole of what the controller is scoped to, and a key carrying less than
 * that leaves a controller in place across a rebind, holding the previous subject's
 * settlement.
 */
export function useActController<TController extends ActControllerSurface>(
  subject: object,
  key: SubjectKey,
  open: () => TController,
): ActControllerBinding<TController> {
  const { value: controller } = useSubjectScopedResource(subject, key, open, CONTROLLER_DISPOSAL);
  return useControllerBinding(controller);
}

/**
 * Bind one subject's act controller whose prerequisite is read against a session store.
 *
 * The key is the whole of what the controller is scoped to — a mount for the modes it
 * admits, a workspace AND its execution mode for a root.
 *
 * AND THE SESSION STORE IS THE AXIS NO KEY CARRIES, which is why it is a parameter
 * rather than something a caller folds into the key. The controller arms its refresh
 * triggers on a store, and a store rebuilt for the same session under an unchanged bridge
 * leaves the whole address standing — so the rule is applied here, once.
 * `store/session/session-store-rebind.ts` states it; a key with the store spelled into it
 * would re-open the controller on a reconnect and lose the prerequisite answer with it.
 */
export function useSessionScopedActController<
  TController extends ActControllerSurface & SessionStoreScoped,
>(
  subject: object,
  key: SubjectKey,
  sessionStore: SessionStore,
  open: () => TController,
): ActControllerBinding<TController> {
  const held = useSubjectScopedResource(subject, key, open, CONTROLLER_DISPOSAL);
  useSessionStoreRebind(held, sessionStore, open);
  return useControllerBinding(held.value);
}

/**
 * How one resource ends, and how one already ended is recognized. Declared once.
 *
 * ONE MODULE-LEVEL OBJECT, because the resource seam holds `dispose` and `isClosed` on
 * dependencies of their own: a literal minted in a render body would hand over a fresh
 * identity on every pass and restart the lifetime beneath it. `dispose` is TERMINAL,
 * which is why `isClosed` travels beside it in the same object rather than being
 * re-derived in an effect — re-derived there, the seam records the corpse as committed,
 * the caller publishes a replacement, and the value-change cleanup calls `dispose()` on
 * the corpse a second time.
 */
export const CONTROLLER_DISPOSAL: SubjectScopedDisposal<DisposableController> = {
  dispose: (controller) => {
    controller.dispose();
  },
  isClosed: (controller) => controller.isDisposed,
};

/** The controller on screen, and its snapshot read through `useSyncExternalStore`. */
function useControllerBinding<TController extends ActControllerSurface>(
  controller: TController,
): ActControllerBinding<TController> {
  const subscribe = useCallback(
    (onReadingChange: () => void) => controller.subscribe(onReadingChange),
    [controller],
  );
  const read = useCallback(() => controller.snapshot, [controller]);
  const reading = useSyncExternalStore(subscribe, read, read);
  return { controller, reading };
}
