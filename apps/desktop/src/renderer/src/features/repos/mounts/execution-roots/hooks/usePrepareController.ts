// How a workspace card holds its prepare controller. It goes through `useActController`'s
// resource seam, not `useMemo`, so a controller built in a discarded render is closed in that
// render. It also `start()`s the triggers in an effect, because the reuse question arrives late.

import { useCallback, useEffect } from "react";
import { useBridgeClock } from "@renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { useSessionScopedActController } from "@renderer/features/repos/acts/hooks/useActController.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import {
  ExecutionRootPrepareController,
  type PrepareOperations,
  type PrepareReading,
  type PrepareSubject,
} from "../prepare-controller.js";

/** What the hook hands a form: the reading, and the three things it can ask for. */
export interface PrepareBinding {
  readonly reading: PrepareReading;
  /**
   * The identity of the controller behind this binding, for state that must die with it. The
   * controller is re-minted when the workspace or its mode moves, and the row is never
   * remounted, so a form addressed at this identity is re-seeded in the render that re-mints.
   */
  readonly controllerIdentity: object;
  readonly checkReuse: (branchName: string) => void;
  readonly prepare: (branchName: string, acknowledgeDirtyCandidate: boolean) => void;
  readonly clearAct: () => void;
}

/**
 * Bind one workspace's prepare controller to a form, keyed on the workspace and mode together,
 * so a mode switch mints a fresh controller and clears the branch and settlement of the old one.
 */
export function usePrepareController(
  bridge: PlatformBridge,
  subject: PrepareSubject,
  sessionStore: SessionStore,
  operations: PrepareOperations,
): PrepareBinding {
  const clock = useBridgeClock();
  const { controller, reading } = useSessionScopedActController(
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
