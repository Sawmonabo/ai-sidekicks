import { useCallback, useMemo } from "react";

import type { ExecutionMode } from "@ai-sidekicks/contracts";

import { consoleClockFor } from "@renderer/services/platform/hooks/useClock.js";
import { type ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { useSessionScopedActController } from "../../../acts/hooks/useActController.js";
import {
  BindWorkspaceController,
  type BindControllerOptions,
  type BindReading,
} from "../bind-controller.js";

/** What the hook hands a surface: the reading, and the three things it can ask for. */
export interface BindBinding {
  readonly reading: BindReading;
  readonly requestCapabilities: () => void;
  readonly bind: (executionMode: ExecutionMode, directory: string | undefined) => void;
  readonly clearAct: () => void;
}

/**
 * Bind one mount's bind controller to a surface.
 *
 * KEYED ON THE MOUNT, which is the whole of what the read and the act are scoped to.
 */
export function useBindController(
  bridge: ConsoleBridge,
  repoMountId: string,
  sessionStore: SessionStore,
  operations: BindControllerOptions["operations"],
): BindBinding {
  // One window, one time base, memoized so a fresh clock per render does not re-mint
  // the controller beneath it.
  const clock = useMemo(() => consoleClockFor(bridge), [bridge]);
  const { controller, reading } = useSessionScopedActController(
    bridge,
    repoMountId,
    sessionStore,
    () => new BindWorkspaceController({ operations, repoMountId, sessionStore, clock }),
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
