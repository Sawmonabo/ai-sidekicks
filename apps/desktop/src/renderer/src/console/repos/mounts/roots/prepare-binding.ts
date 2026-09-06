// How a workspace card holds its prepare controller, and nothing about the prepare.
//
// SPLIT FROM THE CONTROLLER ON `proposal-gate-binding.ts`'S SEAM, and for its reasons:
// the class beside this one collaborates with the bridge and owns what a reuse check
// and a prepare publish; this module collaborates with React's rendering lifecycle and
// owns when a controller is opened, armed, and ended. They meet at one object.
//
// THE SEAM IS `useSubjectScopedResource` AND NOT `useMemo`, which is that module's own
// distinction: a memo opened during a pass React discards really constructs the
// controller and really arms its triggers, and no effect ever commits to end it. The
// resource seam closes one inside the render that drops it.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { consoleClockFor, type ConsoleBridge } from "../../../bridge/index.js";
import {
  useSubjectScopedResource,
  type SessionStore,
  type SubjectScopedDisposal,
} from "../../../store/index.js";
import {
  ExecutionRootPrepareController,
  type PrepareReading,
  type PrepareSubject,
} from "./prepare-controller.js";

/** What the hook hands a surface: the reading, and the four things it can ask for. */
export interface PrepareBinding {
  readonly reading: PrepareReading;
  readonly checkReuse: (branchName: string) => void;
  readonly prepare: (branchName: string, acknowledgeDirtyCandidate: boolean) => void;
  readonly prepareClone: (branchName: string) => void;
  readonly clearAct: () => void;
}

/**
 * Bind one workspace's prepare controller to a surface.
 *
 * KEYED ON THE WORKSPACE AND THE MODE TOGETHER, because both change what the controller
 * would do: the workspace decides which binding is prepared, and the mode decides which
 * of the two calls the surface offers. A key carrying only the first would leave a
 * controller in place across a mode switch, with a reuse verdict about a question the
 * new mode does not ask.
 */
export function usePrepareController(
  bridge: ConsoleBridge,
  subject: PrepareSubject,
  sessionStore: SessionStore,
): PrepareBinding {
  // THE CLOCK COMES FROM THE BRIDGE, on `repo-mounts-binding.ts`'s reason: one window,
  // one time base. Memoised because the real arm mints a fresh clock per call and a
  // new object every render would re-mint the controller beneath it.
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  const { value: controller } = useSubjectScopedResource(
    bridge,
    `${subject.workspaceId} ${subject.executionMode}`,
    () => new ExecutionRootPrepareController({ bridge, subject, sessionStore, clock }),
    PREPARE_CONTROLLER_DISPOSAL,
  );
  useEffect(() => {
    controller.start();
  }, [controller]);
  const subscribe = useCallback(
    (onReadingChange: () => void) => controller.subscribe(onReadingChange),
    [controller],
  );
  const read = useCallback(() => controller.snapshot, [controller]);
  const reading = useSyncExternalStore(subscribe, read, read);
  const checkReuse = useCallback(
    (branchName: string) => {
      controller.checkReuse(branchName);
    },
    [controller],
  );
  const prepare = useCallback(
    (branchName: string, acknowledgeDirtyCandidate: boolean) => {
      void controller.prepare(branchName, acknowledgeDirtyCandidate);
    },
    [controller],
  );
  const prepareClone = useCallback(
    (branchName: string) => {
      void controller.prepareClone(branchName);
    },
    [controller],
  );
  const clearAct = useCallback(() => {
    controller.clearAct();
  }, [controller]);
  return { reading, checkReuse, prepare, prepareClone, clearAct };
}

/** How one controller ends, and how one already ended is recognised. */
const PREPARE_CONTROLLER_DISPOSAL: SubjectScopedDisposal<ExecutionRootPrepareController> = {
  dispose: (controller) => {
    controller.dispose();
  },
  isClosed: (controller) => controller.isDisposed,
};
