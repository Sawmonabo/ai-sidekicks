// How a dialog holds an act controller, and when it is opened and ended. It goes through
// `useSubjectScopedResource`, not `useMemo`, so a controller built in a discarded render
// is closed in that render.

import { useCallback, useSyncExternalStore } from "react";

import type { Unsubscribe } from "#shared/preload-api.js";
import {
  CONTROLLER_DISPOSAL,
  type DisposableController,
} from "#renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { type SubjectKey } from "#renderer/lib/subject-scoped/subject-scoped-holder.js";
import { useSubjectScopedResource } from "#renderer/hooks/subject-scoped/useSubjectScopedResource.js";

/**
 * The lifecycle an act controller offers a dialog: all this hook needs from one. A contract,
 * not a class, so `ActController` and wrappers of it bind alike.
 */
export interface BindableActController<TReading = unknown> extends DisposableController {
  /** What the dialog renders. Read through `useSyncExternalStore`, never reached into. */
  readonly snapshot: TReading;
  subscribe(sink: (reading: TReading) => void): Unsubscribe;
}

/** What the hook hands back: the controller to act through, and what to render. */
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
  const subscribe = useCallback(
    (onReadingChange: () => void) => controller.subscribe(onReadingChange),
    [controller],
  );
  const read = useCallback(() => controller.snapshot, [controller]);
  const reading = useSyncExternalStore(subscribe, read, read);
  return { controller, reading };
}
