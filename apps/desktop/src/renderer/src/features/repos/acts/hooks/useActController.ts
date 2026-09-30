// How a dialog holds an act controller, and when it is opened and ended. It goes through
// `useSubjectScopedResource`, not `useMemo`, so a controller built in a discarded render
// is closed in that render. A controller that asks first also rebinds on a replaced store.

import { useCallback, useSyncExternalStore } from "react";

import type { Unsubscribe } from "@renderer/lib/emitter.js";
import {
  CONTROLLER_DISPOSAL,
  type DisposableController,
} from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { type SubjectKey } from "@renderer/lib/subject-scoped/subject-scoped-holder.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { useSessionStoreRebind, type SessionStoreScoped } from "./useSessionStoreRebind.js";

/**
 * The lifecycle an act controller offers a dialog: all these hooks need from one. A contract,
 * not a class, so `ActController`, `ActControllerBase` and wrappers of them all bind alike.
 */
export interface BindableActController<TReading = unknown> extends DisposableController {
  /** What the dialog renders. Read through `useSyncExternalStore`, never reached into. */
  readonly snapshot: TReading;
  subscribe(sink: (reading: TReading) => void): Unsubscribe;
}

/** What a hook hands back: the controller to act through, and what to render. */
export interface ActControllerBinding<TController extends BindableActController> {
  readonly controller: TController;
  readonly reading: TController["snapshot"];
}

/**
 * Bind one subject's act controller to a dialog. The key must carry everything the controller
 * is scoped to, or a rebind leaves it holding the previous subject's settlement.
 */
export function useActController<TController extends BindableActController>(
  subject: object,
  key: SubjectKey,
  open: () => TController,
): ActControllerBinding<TController> {
  const { value: controller } = useSubjectScopedResource(subject, key, open, CONTROLLER_DISPOSAL);
  return useControllerBinding(controller);
}

/**
 * Bind one subject's act controller whose prerequisite is read against a session store. The
 * key carries everything else (a mount, or a workspace and execution mode); the store is a
 * parameter, not part of the key, so a reconnect rebinds the controller instead of
 * re-opening it and losing the prerequisite answer.
 */
export function useSessionScopedActController<
  TController extends BindableActController & SessionStoreScoped,
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

function useControllerBinding<TController extends BindableActController>(
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
