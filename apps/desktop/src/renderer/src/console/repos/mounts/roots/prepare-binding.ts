// How a workspace card holds its prepare controller, and nothing about the prepare.
//
// SPLIT FROM THE CONTROLLER: the class beside this one owns what a reuse check and a
// prepare publish; this module collaborates with React's rendering lifecycle and owns
// when a controller is opened, armed, and ended. They meet at one object.
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
  type PrepareOperations,
  type PrepareReading,
  type PrepareSubject,
} from "./prepare-controller.js";

/** What the hook hands a surface: the reading, and the three things it can ask for. */
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
  readonly clearAct: () => void;
}

/**
 * Bind one workspace's prepare controller to a surface.
 *
 * KEYED ON THE WORKSPACE AND THE MODE TOGETHER, so a mode switch mints a fresh controller.
 * The form is addressed at the controller's identity, so a fresh controller is what
 * clears a branch typed under the previous mode and drops the settlement of a prepare
 * made under it.
 */
export function usePrepareController(
  bridge: ConsoleBridge,
  subject: PrepareSubject,
  sessionStore: SessionStore,
  operations: PrepareOperations,
): PrepareBinding {
  // THE CLOCK COMES FROM THE BRIDGE: one window, one time base. Memoized because the real
  // arm mints a fresh clock per call and a new object every render would re-mint the
  // controller beneath it.
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  const { controller, reading } = useActController(
    bridge,
    `${subject.workspaceId} ${subject.executionMode}`,
    sessionStore,
    () => new ExecutionRootPrepareController({ operations, subject, sessionStore, clock }),
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
  const clearAct = useCallback(() => {
    controller.clearAct();
  }, [controller]);
  return { reading, controllerIdentity: controller, checkReuse, prepare, clearAct };
}
