import { useCallback } from "react";

import type { ExecutionMode } from "@ai-sidekicks/contracts/repo";

import { useOwnerWindow } from "@renderer/hooks/owner-window/useOwnerWindow.js";
import { useBridgeClock } from "@renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { useSessionScopedActController } from "@renderer/features/repos/acts/hooks/useActController.js";
import {
  BindWorkspaceController,
  type BindControllerOptions,
  type BindReading,
} from "../bind-controller.js";

/** What the hook hands a dialog: the reading, and the three things it can ask for. */
export interface BindBinding {
  readonly reading: BindReading;
  readonly requestCapabilities: () => void;
  readonly bind: (executionMode: ExecutionMode, directory: string | undefined) => void;
  readonly clearAct: () => void;
}

/** Bind one mount's bind controller to a dialog, keyed on the mount. */
export function useBindController(
  bridge: PlatformBridge,
  repoMountId: string,
  sessionStore: SessionStore,
  operations: BindControllerOptions["operations"],
): BindBinding {
  const clock = useBridgeClock();
  const ownerWindow = useOwnerWindow();
  const { controller, reading } = useSessionScopedActController(
    bridge,
    repoMountId,
    sessionStore,
    () =>
      new BindWorkspaceController({
        operations,
        repoMountId,
        sessionStore,
        ownerWindow,
        clock,
      }),
  );
  const requestCapabilities = useCallback(() => {
    controller.requestCapabilities();
  }, [controller]);
  const bind = useCallback(
    (executionMode: ExecutionMode, directory: string | undefined) => {
      void controller.bind(executionMode, directory);
    },
    [controller],
  );
  const clearAct = useCallback(() => {
    controller.clearAct();
  }, [controller]);
  return { reading, requestCapabilities, bind, clearAct };
}
