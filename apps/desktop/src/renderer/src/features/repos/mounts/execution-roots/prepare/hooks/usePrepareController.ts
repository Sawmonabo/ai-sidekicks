// How a workspace card holds its prepare controller. It goes through `useActController`'s
// resource seam, not `useMemo`, so a controller built in a discarded render is closed in that
// render.

import { useCallback } from "react";

import type { ExecutionMode } from "@ai-sidekicks/contracts/repo/mount";

import { type PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { useActController } from "#renderer/features/repos/acts/hooks/useActController.js";
import {
  ExecutionRootPrepareController,
  type PrepareOperations,
  type PrepareReading,
} from "../controller.js";

/** What the hook hands a form: the reading, and the two things it can ask for. */
export interface PrepareBinding {
  readonly reading: PrepareReading;
  /**
   * The identity of the controller behind this binding, for state that must die with it. The
   * controller is re-minted when the workspace or its mode moves, and the row is never
   * remounted, so a form addressed at this identity is re-seeded in the render that re-mints.
   */
  readonly controllerIdentity: object;
  readonly prepare: (branchName: string) => void;
  readonly clearAct: () => void;
}

/**
 * Bind one workspace's prepare controller to a form, keyed on the workspace and mode together,
 * so a workspace bound again in another mode mints a fresh controller and drops the old one's
 * branch and settlement.
 */
export function usePrepareController(
  bridge: PlatformBridge,
  subject: PrepareSubject,
  operations: PrepareOperations,
): PrepareBinding {
  const { controller, reading } = useActController(
    bridge,
    `${subject.workspaceId} ${subject.executionMode}`,
    () => new ExecutionRootPrepareController({ operations, workspaceId: subject.workspaceId }),
  );
  const prepare = useCallback(
    (branchName: string) => {
      void controller.prepare(branchName);
    },
    [controller],
  );
  const clearAct = useCallback(() => {
    controller.clearAct();
  }, [controller]);
  return { reading, controllerIdentity: controller, prepare, clearAct };
}

/** What one prepare form is scoped to: a workspace, in one mode. */
interface PrepareSubject {
  readonly workspaceId: string;
  readonly executionMode: ExecutionMode;
}
