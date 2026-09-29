import { useCallback } from "react";

import type { ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { useActController } from "../../../acts/hooks/useActController.js";
import type { RepoOperations } from "../../../repo-operations.js";
import { AttachController, type AttachRequestReading } from "../attach-controller.js";

/** What the hook hands a surface: the reading, and the two things it can ask for. */
export interface AttachBinding {
  readonly reading: AttachRequestReading;
  readonly attach: (localPath: string) => void;
  readonly clearAct: () => void;
}

/**
 * Bind one session section's attach controller to a surface.
 *
 * KEYED ON THE SESSION, so a section re-addressed to another session drops the
 * settlement the previous one's dialog was showing.
 */
export function useAttachController(
  bridge: ConsoleBridge,
  sessionId: string,
  operations: Pick<RepoOperations, "attachRepository">,
): AttachBinding {
  const { controller, reading } = useActController(
    bridge,
    sessionId,
    () => new AttachController({ operations }),
  );
  const attach = useCallback(
    (localPath: string) => {
      void controller.attach(localPath);
    },
    [controller],
  );
  const clearAct = useCallback(() => {
    controller.clearAct();
  }, [controller]);
  return { reading, attach, clearAct };
}
