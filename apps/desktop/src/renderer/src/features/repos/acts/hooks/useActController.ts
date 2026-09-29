// How a surface holds an act controller, and nothing about the act.
//
// The controller classes collaborate with a wire call and own what an act and its
// prerequisite publish; these hooks collaborate with React's rendering lifecycle and own
// when a controller is opened and ended. They meet at one object.
//
// THE SEAM IS `useSubjectScopedResource` AND NOT `useMemo`: a controller constructed
// during a pass React discards is a real object with real triggers armed, and no effect
// ever commits to end it. The resource seam closes one inside the render that drops it.
//
// TWO HOOKS, ONE PER KIND OF CONTROLLER. An act with no prerequisite arms nothing on a
// session store, so it binds by subject and key alone. A controller that asks first arms
// its refresh triggers on a store, and binds through the second hook, which also rebinds
// it when that store is replaced under an unchanged key.

import { useCallback, useSyncExternalStore } from "react";

import type { Unsubscribe } from "@renderer/lib/emitter.js";
import {
  CONTROLLER_DISPOSAL,
  type DisposableController,
} from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { type SubjectKey } from "@renderer/lib/subject-scoped/subject-scoped-holder.js";
import { useSubjectScopedResource } from "@renderer/console/store/subject-scoped/subject-scoped-resource.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { useSessionStoreRebind, type SessionStoreScoped } from "./useSessionStoreRebind.js";

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
 * leaves the whole address standing — so the rule is applied here, once. A key with the
 * store spelled into it would re-open the controller on a reconnect and lose the
 * prerequisite answer with it.
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
