// How a workspace card holds its prepare controller, and nothing about the prepare.
//
// SPLIT FROM THE CONTROLLER ON `proposal-gate-binding.ts`'S SEAM, and for its reasons:
// the class beside this one collaborates with the bridge and owns what a reuse check
// and a prepare publish; this module collaborates with React's rendering lifecycle and
// owns when a controller is opened, armed, and ended. They meet at one object.
//
// THE SEAM IS `store/act/use-act-controller.ts` AND NOT `useMemo`, which is that module's
// own distinction: a memo opened during a pass React discards really constructs the
// controller and really arms its triggers, and no effect ever commits to end it. The
// resource seam that hook is built on closes one inside the render that drops it.
//
// WHAT IS LEFT HERE IS THE ARMING. The three sibling controllers all bind through that
// one hook; this one is the only one that also has to `start()` the triggers in an
// effect, because its question arrives late and the hook takes no first read for it.

import { useCallback, useEffect, useMemo } from "react";

import { consoleClockFor, type ConsoleBridge } from "../../../bridge/index.js";
import { useActController, type SessionStore } from "../../../store/index.js";
import {
  ExecutionRootPrepareController,
  type PrepareReading,
  type PrepareSubject,
} from "./prepare-controller.js";

/** What the hook hands a surface: the reading, and the four things it can ask for. */
export interface PrepareBinding {
  readonly reading: PrepareReading;
  /**
   * The identity of the controller behind this binding, for state that must die with it.
   *
   * TYPED `object` SO A SURFACE SCOPES TO IT AND NEVER REACHES THROUGH IT. The controller
   * is re-minted whenever the workspace or its execution mode moves, and a form held in a
   * plain register survives that — the row is keyed by workspace id, so React never
   * remounts it — leaving a branch typed under the previous mode sitting above a
   * controller that has asked nothing. Handing back the identity lets the surface address
   * `useSubjectScopedState` at it and be re-seeded during the render that re-mints,
   * rather than one committed frame later.
   */
  readonly controllerIdentity: object;
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
  const { controller, reading } = useActController(
    bridge,
    `${subject.workspaceId} ${subject.executionMode}`,
    sessionStore,
    () => new ExecutionRootPrepareController({ bridge, subject, sessionStore, clock }),
  );
  useEffect(() => {
    controller.start();
  }, [controller]);
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
  return { reading, controllerIdentity: controller, checkReuse, prepare, prepareClone, clearAct };
}
